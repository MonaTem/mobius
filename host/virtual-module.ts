import * as ts from "typescript";
import { ServerModuleGlobal } from "./server-compiler";
import validationModule from "./validation-module";
import cssModule from "./css-module";

export type ModuleMap = { [modulePath: string]: string };
export type StaticAssets = { [path: string]: { contents: string; integrity: string; } };

export type VirtualModuleConstructor = (path: string, minify: boolean) => VirtualModule | void;

export interface VirtualModule {
	generateTypeDeclaration: () => string;
	generateModule: (program: ts.Program) => string;
	instantiateModule: (program: ts.Program, moduleMap: ModuleMap, staticAssets: StaticAssets) => (global: ServerModuleGlobal) => void;
}

export default function(path: string, minify: boolean): VirtualModule | void {
	return validationModule(path) || cssModule(path, minify);
}
