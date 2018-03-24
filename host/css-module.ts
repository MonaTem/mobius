import { ModuleMap, StaticAssets, VirtualModule } from "./virtual-module";
import * as ts from "typescript";
import { relative } from "path";

const cssPathPattern = /\.css$/;

const core = new (require("css-modules-loader-core") as any)();

export default function(path: string) : VirtualModule | void {
	if (cssPathPattern.test(path) && ts.sys.fileExists(path)) {
		const result: any = core.load(ts.sys.readFile(path), relative(ts.sys.getCurrentDirectory(), path));
		const injectableSource = result.injectableSource as string;
		const exportTokens = result.exportTokens as { [key: string]: string };
		return {
			generateTypeDeclaration() {
				return Object.keys(exportTokens).map((symbolName) => `export const ${symbolName}: string;`).join("\n");
			},
			generateModule(program: ts.Program) {
				return Object.keys(exportTokens).map((symbolName) => `export const ${symbolName} = ${JSON.stringify(exportTokens[symbolName])};`).join("\n") + `\n/*css-start:${path}\n${injectableSource}\n:css-end*/\n`;
			},
			instantiateModule(program: ts.Program, moduleMap: ModuleMap, staticAssets: StaticAssets) {
				return (global) => {
					Object.defineProperty(global.exports, "__esModule", { value: true });
					Object.assign(global.exports, exportTokens);
					const link = (global.require("document") as Document).createElement("link");
					link.rel = "stylesheet";
					const href = moduleMap[path];
					link.href = href;
					if (href in staticAssets) {
						link.setAttribute("integrity", staticAssets[href].integrity);
					}
					const body = (global.require("body") as HTMLBodyElement);
					body.insertBefore(link, body.lastElementChild && body.lastElementChild.previousElementSibling);
				};
			},
		};
	}
};
