import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverDoubaoAddition, DoubaoFile } from "./types"
import { ClientDoubao } from "./util"

const DEFAULT_ROOT = "0"

export class DriverDoubao implements StorageDriver {
  private client: ClientDoubao
  private pathCache = new Map<string, string>()

  constructor(addition: DriverDoubaoAddition) {
    this.client = new ClientDoubao(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private fileToItem(f: DoubaoFile): FileItem {
    const isDir = f.node_type === 1
    return {
      name: f.name,
      size: f.size || 0,
      is_dir: isDir,
      modified: f.update_time
        ? new Date(f.update_time * 1000).toISOString()
        : new Date().toISOString(),
      sign: "",
      type: calcFileType(f.name, isDir),
      raw_url: "",
    }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const dirId = await this.resolveDirId(physicalPath)
    const files = await this.client.getFiles(dirId)
    return files.map((f) => this.fileToItem(f))
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const rawName = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, -1).join("/")
    try {
      const parentId = await this.resolveDirId(parentPath)
      const files = await this.client.getFiles(parentId)
      const file = files.find((f) => f.name === rawName)
      if (file) {
        const item = this.fileToItem(file)
        if (!item.is_dir) {
          try {
            item.raw_url = await this.client.getDownloadUrl(file)
            item.raw_url_headers = this.client.downloadHeaders()
          } catch (e: any) {
            item.raw_url_error = e.message
          }
        }
        return item
      }
    } catch {}

    // Fallback: 目录
    try {
      await this.resolveDirId(physicalPath)
      return {
        name: rawName,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    } catch {
      return {
        name: rawName,
        size: 0,
        is_dir: false,
        modified: new Date().toISOString(),
        sign: "",
        type: 0,
        raw_url: "",
      }
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "new_folder"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveDirId(parentPath)
    await this.client.mkdir(parentId, name)
    this.pathCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    // physicalPath 指向被重命名的条目本身（文件或目录），resolveDirId 只认目录，
    // 文件会直接抛 "Directory 'xxx' not found"，必须用 resolveEntry 拿 id
    const entry = await this.resolveEntry(physicalPath)
    await this.client.rename(entry.id, newName)
    this.pathCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    // 同 rename：被删的可能是文件，resolveDirId 会误判
    const entry = await this.resolveEntry(physicalPath)
    await this.client.remove(entry.id)
    this.pathCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    // dstDir 是虚拟路径（含挂载前缀），resolveDirId 期望的是物理路径；
    // 用 dstPhysical 的父目录解析目标目录 id
    const entry = await this.resolveEntry(srcPhysical)
    const dstParts = dstPhysical.split("/").filter(Boolean)
    dstParts.pop()
    const dstParentPath = "/" + dstParts.join("/")
    const dstId = await this.resolveDirId(dstParentPath)
    await this.client.move(entry.id, entry.parentId, dstId)
    this.pathCache.clear()
  }

  async copy(): Promise<void> {
    throw new Error("[Doubao] copy not supported")
  }

  async put(): Promise<void> {
    throw new Error("[Doubao] upload not supported in stateless environment")
  }

  private async resolveDirId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return DEFAULT_ROOT
    if (this.pathCache.has(clean)) return this.pathCache.get(clean)!

    const parts = clean.split("/")
    let currentId = DEFAULT_ROOT
    for (let i = 0; i < parts.length; i++) {
      // 缓存键统一用无前导斜杠的相对路径（与开头的 has(clean) 一致，
      // 之前 set 时带了 "/" 前缀导致缓存永远命中不了）
      const key = parts.slice(0, i + 1).join("/")
      if (this.pathCache.has(key)) {
        currentId = this.pathCache.get(key)!
        continue
      }
      const files = await this.client.getFiles(currentId)
      const target = files.find((f) => f.node_type === 1 && f.name === parts[i])
      if (!target) throw new Error(`[Doubao] Directory '${parts[i]}' not found`)
      currentId = target.id
      this.pathCache.set(key, currentId)
    }
    return currentId
  }

  private async resolveEntry(physicalPath: string): Promise<{ id: string; parentId: string; isDir: boolean }> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.resolveDirId(parentPath)
    const files = await this.client.getFiles(parentId)
    const file = files.find((f) => f.name === name)
    if (!file) throw new Error(`[Doubao] '${name}' not found`)
    return { id: file.id, parentId: file.parent_id || parentId, isDir: file.node_type === 1 }
  }
}
