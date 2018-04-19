import * as babel from "babel-core";
import { readFileSync } from "fs";
import { cwd } from "process";
import * as ts from "typescript";
import * as vm from "vm";
import { packageRelative } from "./fileUtils";
import memoize from "./memoize";
import noImpureGetters from "./noImpureGetters";
import rewriteDynamicImport from "./rewriteDynamicImport";
import rewriteForInStatements from "./rewriteForInStatements";
import { ModuleMap, StaticAssets, VirtualModule } from "./virtual-module";

let convertToCommonJS: any;
let optimizeClosuresInRender: any;
let dynamicImport: any;
let transformAsyncToPromises: any;

export interface ServerModule {
	exports: any;
	paths: string[];
}

export interface ServerModuleGlobal {
	self: this;
	global: this | NodeJS.Global;
	require: (name: string) => any;
	module: ServerModule;
	exports: any;
	Object?: typeof Object;
	Array?: typeof Array;
}

declare global {
	namespace NodeJS {
		export interface Global {
			newModule?: (global: any) => void;
		}
	}
}

export type ModuleSource = { path: string, sandbox: boolean } & ({ from: "file" } | { from: "string", code: string });

function wrapSource(code: string) {
	return `(function(self){return(function(self,global,require,document,exports,Math,Date,setInterval,clearInterval,setTimeout,clearTimeout){${code}\n})(self,self.global,self.require,self.document,self.exports,self.Math,self.Date,self.setInterval,self.clearInterval,self.setTimeout,self.clearTimeout)})`;
}

export const compilerOptions = (() => {
	const fileName = "tsconfig-server.json";
	const configFile = ts.readJsonConfigFile(packageRelative(fileName), (path: string) => readFileSync(path).toString());
	const configObject = ts.convertToObject(configFile, []);
	return ts.convertCompilerOptionsFromJson(configObject.compilerOptions, packageRelative("./"), fileName).options;
})();

const diagnosticsHost = {
	getCurrentDirectory: cwd,
	getCanonicalFileName(fileName: string) {
		return fileName;
	},
	getNewLine() {
		return "\n";
	},
};

type ModuleLoader = (module: ServerModule, globalProperties: any, require: (name: string) => any) => void;

const declarationPattern = /\.d\.ts$/;

export class ServerCompiler {
	private loadersForPath = new Map<string, ModuleLoader>();
	private languageService: ts.LanguageService;
	private host: ts.LanguageServiceHost & ts.ModuleResolutionHost;
	private program: ts.Program;
	private resolutionCache: ts.ModuleResolutionCache;

	constructor(mainFile: string, private moduleMap: ModuleMap, private staticAssets: StaticAssets, public virtualModule: (path: string) => VirtualModule | void, fileRead: (path: string) => void) {
		// Hijack TypeScript's file access so that we can instrument when it reads files for watching and to inject virtual modules
		fileRead = memoize(fileRead);
		const fileNames = [/*packageRelative("dist/common/preact.d.ts"), */packageRelative("types/reduced-dom.d.ts"), mainFile];
		const readFile = (path: string, encoding?: string) => {
			if (declarationPattern.test(path)) {
				const module = virtualModule(path.replace(declarationPattern, ""));
				if (module) {
					return module.generateTypeDeclaration();
				}
			}
			fileRead(path);
			return ts.sys.readFile(path, encoding);
		};
		this.host = {
			getScriptFileNames() {
				return fileNames;
			},
			getScriptVersion(fileName) {
				return "0";
			},
			getScriptSnapshot(fileName) {
				const contents = readFile(fileName);
				if (typeof contents !== "undefined") {
					return ts.ScriptSnapshot.fromString(contents);
				}
				return undefined;
			},
			getCurrentDirectory() {
				return ts.sys.getCurrentDirectory();
			},
			getCompilationSettings() {
				return compilerOptions;
			},
			getDefaultLibFileName(options) {
				return ts.getDefaultLibFilePath(options);
			},
			readFile,
			fileExists(path: string) {
				const result = ts.sys.fileExists(path);
				if (result) {
					return result;
				}
				if (declarationPattern.test(path) && virtualModule(path.replace(declarationPattern, ""))) {
					return true;
				}
				return false;
			},
			readDirectory: ts.sys.readDirectory,
			directoryExists(directoryName: string): boolean {
				return ts.sys.directoryExists(directoryName);
			},
			getDirectories(directoryName: string): string[] {
				return ts.sys.getDirectories(directoryName);
			},
		};
		this.languageService = ts.createLanguageService(this.host, ts.createDocumentRegistry());
		this.program = this.languageService.getProgram();
		this.resolutionCache = ts.createModuleResolutionCache(this.host.getCurrentDirectory(), (s) => s);
		const diagnostics = ts.getPreEmitDiagnostics(this.program);
		if (diagnostics.length) {
			console.log(ts.formatDiagnostics(diagnostics, diagnosticsHost));
		}
	}

	public resolveModule(moduleName: string, containingFile: string) {
		const result = ts.resolveModuleName(moduleName, containingFile, compilerOptions, this.host, this.resolutionCache).resolvedModule;
		return result && !result.isExternalLibraryImport ? result.resolvedFileName : undefined;
	}

	public loadModule(source: ModuleSource, module: ServerModule, globalProperties: any, require: (name: string) => any) {
		// Create a sandbox with exports for the provided module
		const path = source.path;
		let result = this.loadersForPath.get(path);
		if (!result) {
			const initializer = source.from === "file" ? this.initializerForPath(path, require) : vm.runInThisContext(wrapSource(source.code), {
				filename: path,
				lineOffset: 0,
				displayErrors: true,
			}) as (global: any) => void;
			if (initializer) {
				const constructModule = function(currentModule: ServerModule, currentGlobalProperties: any, currentRequire: (name: string) => any) {
					const moduleGlobal: ServerModuleGlobal & any = Object.create(global);
					Object.assign(moduleGlobal, currentGlobalProperties);
					moduleGlobal.self = moduleGlobal;
					moduleGlobal.global = global;
					moduleGlobal.require = currentRequire;
					moduleGlobal.module = currentModule;
					moduleGlobal.exports = currentModule.exports;
					initializer(moduleGlobal);
					return moduleGlobal;
				};
				if (source.sandbox) {
					result = constructModule;
				} else {
					const staticModule = constructModule(module, globalProperties, require);
					result = () => staticModule;
				}
			} else {
				result = () => {
					throw new Error("Unable to find module: " + path);
				};
			}
			this.loadersForPath.set(path, result);
		}
		return result(module, globalProperties, require);
	}

	private initializerForPath(path: string, staticRequire: (name: string) => any): ((global: any) => void) | undefined {
		// Check for declarations
		if (declarationPattern.test(path)) {
			const module = this.virtualModule(path.replace(declarationPattern, ""));
			if (module) {
				const instantiate = module.instantiateModule(this.moduleMap, this.staticAssets);
				return instantiate;
			}
		}
		// Extract compiled output and source map from TypeScript
		let scriptContents: string | undefined;
		let scriptMap: string | undefined;
		if (this.program.getSourceFile(path)) {
			for (const { name, text } of this.languageService.getEmitOutput(path).outputFiles) {
				if (/\.js$/.test(name)) {
					scriptContents = text;
				} else if (/\.js\.map$/.test(name)) {
					scriptMap = text;
				}
			}
		}
		// Apply babel transformation passes
		if (!convertToCommonJS) {
			convertToCommonJS = require("babel-plugin-transform-es2015-modules-commonjs")();
		}
		if (!optimizeClosuresInRender) {
			optimizeClosuresInRender = require("babel-plugin-optimize-closures-in-render")(babel);
		}
		if (!dynamicImport) {
			dynamicImport = require("babel-plugin-syntax-dynamic-import")();
		}
		if (!transformAsyncToPromises) {
			transformAsyncToPromises = require("babel-plugin-transform-async-to-promises");
		}
		const firstPass = babel.transform(typeof scriptContents === "string" ? scriptContents : readFileSync(path.replace(/\.d\.ts$/, ".js")).toString(), {
			babelrc: false,
			plugins: [
				dynamicImport,
				rewriteDynamicImport,
				convertToCommonJS,
				noImpureGetters(),
			],
			inputSourceMap: typeof scriptMap === "string" ? JSON.parse(scriptMap) : undefined,
		});
		const secondPass = babel.transform("self = " + wrapSource(firstPass.code!), {
			babelrc: false,
			plugins: [
				convertToCommonJS,
				[transformAsyncToPromises(babel), { externalHelpers: true, hoist: true }],
				optimizeClosuresInRender,
				rewriteForInStatements(),
			],
		});
		// Wrap in the sandbox JavaScript
		return vm.runInThisContext(`(function(require,self){${secondPass.code!}\nreturn self})`, {
			filename: path,
			lineOffset: 0,
			displayErrors: true,
		})(staticRequire) as (global: any) => void;
	}
}
