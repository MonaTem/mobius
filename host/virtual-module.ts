import * as ts from "typescript";
import { ServerModuleGlobal } from "./server-compiler";
import validationModule from "./validation-module";

export type VirtualModuleConstructor = (path: string) => VirtualModule | void;

export interface VirtualModule {
	generateTypeDeclaration: () => string;
	generateModule: (program: ts.Program) => string;
	instantiateModule: (program: ts.Program) => (global: ServerModuleGlobal) => void;	
}

export default function(path: string): VirtualModule | void {
	return validationModule(path);
}
