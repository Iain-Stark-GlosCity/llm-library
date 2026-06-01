// ETag-aware blob helpers + container clients. Containers are created on first use.
// See CLAUDE.md "ETag-aware blob write pattern".

import { BlobServiceClient, ContainerClient } from '@azure/storage-blob'
import { getConfig } from '../config'
import { DomainException } from '../types'

let rawInit: Promise<ContainerClient> | null = null
let wikiInit: Promise<ContainerClient> | null = null
let schemaInit: Promise<ContainerClient> | null = null

function serviceClient(): BlobServiceClient {
  const cfg = getConfig()
  if (!cfg.storageConnectionString) {
    throw new DomainException('STORAGE_ERROR', 'LIBRARY_STORAGE_CONNECTION_STRING is not configured')
  }
  return BlobServiceClient.fromConnectionString(cfg.storageConnectionString)
}

async function initContainer(name: string): Promise<ContainerClient> {
  const client = serviceClient().getContainerClient(name)
  await client.createIfNotExists()
  return client
}

export function getRawContainer(): Promise<ContainerClient> {
  if (!rawInit) {
    rawInit = initContainer(getConfig().rawContainer).catch((err) => {
      rawInit = null
      throw err
    })
  }
  return rawInit
}

export function getWikiContainer(): Promise<ContainerClient> {
  if (!wikiInit) {
    wikiInit = initContainer(getConfig().wikiContainer).catch((err) => {
      wikiInit = null
      throw err
    })
  }
  return wikiInit
}

export function getSchemaContainer(): Promise<ContainerClient> {
  if (!schemaInit) {
    schemaInit = initContainer(getConfig().schemaContainer).catch((err) => {
      schemaInit = null
      throw err
    })
  }
  return schemaInit
}

export interface BlobReadResult {
  content: string
  etag: string
}

export interface WriteResult {
  success: boolean
  conflict: boolean
  newEtag?: string
}

async function streamToString(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!stream) return ''
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

// Returns null if the blob does not exist.
export async function readBlob(
  container: ContainerClient,
  blobName: string
): Promise<BlobReadResult | null> {
  const blob = container.getBlockBlobClient(blobName)
  try {
    const download = await blob.download()
    const content = await streamToString(download.readableStreamBody)
    return { content, etag: download.etag! }
  } catch (err: any) {
    if (err.statusCode === 404) return null
    throw new DomainException('STORAGE_ERROR', `Failed to read ${blobName}: ${err.message}`)
  }
}

// Unconditional overwrite (used for content blobs: raw sources, history copies).
export async function writeBlob(
  container: ContainerClient,
  blobName: string,
  content: string,
  contentType = 'text/markdown; charset=utf-8'
): Promise<void> {
  const blob = container.getBlockBlobClient(blobName)
  await blob.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: contentType }
  })
}

// ETag conditional write. etag === null means "create only if absent" (If-None-Match: *).
export async function conditionalWrite(
  container: ContainerClient,
  blobName: string,
  content: string,
  etag: string | null,
  contentType = 'application/json; charset=utf-8'
): Promise<WriteResult> {
  const blob = container.getBlockBlobClient(blobName)
  try {
    const response = await blob.upload(content, Buffer.byteLength(content), {
      conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
      blobHTTPHeaders: { blobContentType: contentType }
    })
    return { success: true, conflict: false, newEtag: response.etag }
  } catch (err: any) {
    if (err.statusCode === 412 || err.statusCode === 409) {
      return { success: false, conflict: true }
    }
    throw new DomainException('STORAGE_ERROR', `Failed to write ${blobName}: ${err.message}`)
  }
}

export async function listBlobs(container: ContainerClient, prefix: string): Promise<string[]> {
  const names: string[] = []
  for await (const item of container.listBlobsFlat({ prefix })) {
    names.push(item.name)
  }
  return names
}

// Hard-delete a blob (the librarian cleanup escape hatch). Idempotent: returns true if
// the blob existed and was removed, false if it was already absent. Unlike writes there
// is no ETag guard — deletion is unconditional by design.
export async function deleteBlob(container: ContainerClient, blobName: string): Promise<boolean> {
  const blob = container.getBlockBlobClient(blobName)
  try {
    const res = await blob.deleteIfExists()
    return res.succeeded
  } catch (err: any) {
    throw new DomainException('STORAGE_ERROR', `Failed to delete ${blobName}: ${err.message}`)
  }
}
