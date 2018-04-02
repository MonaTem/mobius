import Core from "css-modules-loader-core";
import { relative } from "path";
import { Root as CSSRoot, Rule as CSSRule } from "postcss";
import * as ts from "typescript";
import { ModuleMap, StaticAssets, VirtualModule } from "./virtual-module";

const cssPathPattern = /\.css$/;

export const postcssMinifyPlugin = require("cssnano")({
	preset: "default",
	svgo: false,
});

function removeRule(rule: CSSRule) {
	rule.remove();
	return false;
}

export default function(path: string, minify: boolean): VirtualModule | void {
	if (cssPathPattern.test(path) && ts.sys.fileExists(path)) {
		const fileContents = ts.sys.readFile(path)!;
		const relativePath = relative(ts.sys.getCurrentDirectory(), path);
		const sanitisedPath = relativePath.replace(/\.[^\.\/\\]+$/, "").replace(/[\W_]+/g, "_").replace(/^_|_$/g, "");
		let deadPattern: RegExp | undefined;
		const names: { [name: string]: number; } = {};
		let i: number = 0;
		const pluginChain = [Core.values, Core.localByDefault, Core.extractImports, Core.scope({ generateScopedName }), (root: CSSRoot) => {
			if (typeof deadPattern !== "undefined") {
				root.walkRules(deadPattern, removeRule);
			}
		}];
		if (minify) {
			pluginChain.push(postcssMinifyPlugin);
		}
		const core = new Core(pluginChain);
		let result = compile();
		function compile() {
			const lazy: any = core.load(fileContents, relativePath);
			return {
				css: lazy.injectableSource as string,
				exportTokens: lazy.exportTokens as { [symbolName: string]: string },
				map: lazy.map,
			};
		}
		function generateScopedName(exportedName: string) {
			return "_" + sanitisedPath + (minify ? (typeof names[exportedName] == "undefined" ? (names[exportedName] = i++) : names[exportedName]).toString(36) : "_" + exportedName);
		}
		return {
			generateTypeDeclaration() {
				return Object.keys(result.exportTokens).map((symbolName) => `export const ${symbolName}: string;`).join("\n");
			},
			generateModule(program: ts.Program) {
				return Object.keys(result.exportTokens).map((symbolName) => `export const ${symbolName} = ${JSON.stringify(result.exportTokens[symbolName])};`).join("\n");
			},
			generateStyles(usedExports?: string[]) {
				if (typeof usedExports !== "undefined" && typeof deadPattern === "undefined") {
					const patterns = Object.keys(result.exportTokens).filter((name) => usedExports.indexOf(name) === -1).map((name) => result.exportTokens[name].replace(/([.?*+^$[\]\\(){}|-])/g, "\\$1"));
					if (patterns.length) {
						deadPattern = new RegExp("[#.](" + patterns.join("|") + ")\\b");
						result = compile();
					}
				}
				return { css: result.css, map: result.map };
			},
			instantiateModule(program: ts.Program, moduleMap: ModuleMap, staticAssets: StaticAssets) {
				const href = moduleMap[path];
				const integrity = staticAssets[href] ? staticAssets[href].integrity : undefined;
				return (global) => {
					Object.defineProperty(global.exports, "__esModule", { value: true });
					Object.assign(global.exports, result.exportTokens);
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
