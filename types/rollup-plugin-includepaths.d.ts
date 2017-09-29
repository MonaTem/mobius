import { Plugin } from "rollup";

declare module "rollup-plugin-includepaths";

interface IncludePathOptions {
	paths?: string[],
	include?: { [name: string] : string },
	external?: string[],
	extensions?: string[]
}

export default function(options?: IncludePathOptions) : Plugin;
