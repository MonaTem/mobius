import { ServerModuleGlobal } from "./server-compiler";
import * as ts from "typescript";

export interface VirtualModule {
	readonly suffix: string;
	generateTypeDeclaration: (parentPath: string) => string;
	compileModule: (parentPath: string, parentSource: ts.SourceFile, program: ts.Program) => string;
	instantiateModule: (parentPath: string, parentSource: ts.SourceFile, program: ts.Program) => (global: ServerModuleGlobal) => void;
}
