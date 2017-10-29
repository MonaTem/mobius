///<reference types="node" />
declare module "iltorb";

export interface CompressParams {
	mode?: 0 | 1 | 2;
	quality?: number;
	lgwin?: number;
	lgblock?: number;
	size_hint?: number;
	disable_literal_context_modeling?: boolean;
}

export function compress(buffer: Buffer, params: CompressParams, callback: (err: any, result?: Buffer) => void): void;
export function compressStream(params?: CompressParams): NodeJS.ReadWriteStream;
export function compressSync(buffer: Buffer, params?: CompressParams): Buffer;

export function decompress(buffer: Buffer, callback: (err: any, result?: Buffer) => void): void;
export function decompressStream(params?: CompressParams): NodeJS.ReadWriteStream;
export function decompressSync(buffer: Buffer): Buffer;
