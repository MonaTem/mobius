import * as fs from "fs";
import { join as pathJoin } from "path";
import * as util from "util";

export const packageRelative = (relative: string) => pathJoin(__dirname, "../..", relative);

export const readFile = util.promisify(fs.readFile);
export async function readJSON(path: string) {
	return JSON.parse((await readFile(path)).toString());
}
export const writeFile = util.promisify(fs.writeFile);

export const mkdir = util.promisify(fs.mkdir);

export const unlink = util.promisify(fs.unlink);
let rimrafLazy: (path: string) => Promise<void> | undefined;
export async function rimraf(path: string) {
	if (!rimrafLazy) {
		rimrafLazy = util.promisify(require("rimraf")) as (path: string) => Promise<void>;
	}
	await rimrafLazy(path);
}

export const stat = util.promisify(fs.stat);
export function exists(path: string) {
	return new Promise<boolean>((resolve) => fs.exists(path, resolve));
}
