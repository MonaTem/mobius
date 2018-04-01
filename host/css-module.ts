import Core from "css-modules-loader-core";
import { relative } from "path";
import * as ts from "typescript";
import { ModuleMap, StaticAssets, VirtualModule } from "./virtual-module";

const cssPathPattern = /\.css$/;

const defaultCore = new Core([Core.values, Core.localByDefault, Core.extractImports, Core.scope]);

export const postcssMinifyPlugin = require("cssnano")({
	preset: "default",
	svgo: false,
});

export default function(path: string, minify: boolean): VirtualModule | void {
	if (cssPathPattern.test(path) && ts.sys.fileExists(path)) {
		const relativePath = relative(ts.sys.getCurrentDirectory(), path);
		let selectedCore = defaultCore;
		if (minify) {
			const names: { [name: string]: number; } = {};
			let i: number = 0;
			const sanitisedPath = relativePath.replace(/\.[^\.\/\\]+$/, "").replace(/[\W_]+/g, "_").replace(/^_|_$/g, "");
			selectedCore = new Core([Core.values, Core.localByDefault, Core.extractImports, Core.scope({ generateScopedName(exportedName: string) {
				return "_" + sanitisedPath + (names[exportedName] || (names[exportedName] = i++)).toString(36);
			}}), postcssMinifyPlugin]);
		}
		const result: any = selectedCore.load(ts.sys.readFile(path)!, relativePath);
		const css = result.injectableSource;
		const exportTokens = result.exportTokens;
		const map = result.map;
		return {
			generateTypeDeclaration() {
				return Object.keys(exportTokens).map((symbolName) => `export const ${symbolName}: string;`).join("\n");
			},
			generateModule(program: ts.Program) {
				return Object.keys(exportTokens).map((symbolName) => `export const ${symbolName} = ${JSON.stringify(exportTokens[symbolName])};`).join("\n");
			},
			generateStyles() {
				return { css, map };
			},
			instantiateModule(program: ts.Program, moduleMap: ModuleMap, staticAssets: StaticAssets) {
				const href = moduleMap[path];
				const integrity = staticAssets[href] ? staticAssets[href].integrity : undefined;
				return (global) => {
					Object.defineProperty(global.exports, "__esModule", { value: true });
					Object.assign(global.exports, exportTokens);
					const link = (global.require("document") as Document).createElement("link");
					link.rel = "stylesheet";
					link.href = href;
					if (integrity) {
						link.setAttribute("integrity", integrity);
					}
					const body = (global.require("body") as HTMLBodyElement);
					body.insertBefore(link, body.lastElementChild && body.lastElementChild.previousElementSibling);
				};
			},
		};
	}
}
