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

export type ModuleSource = { from: "file", path: string } | { from: "string", code: string, path: string };

const compilerOptions = (() => {
	const fileName = "tsconfig-server.json";
	const configFile = ts.readJsonConfigFile(packageRelative(fileName), (path: string) => readFileSync(path).toString());
	const configObject = ts.convertToObject(configFile, []);
	return ts.convertCompilerOptionsFromJson(configObject.compilerOptions, packageRelative("./"), fileName).options;
})();

function sandbox(code: string, filename: string): (global: any) => void {
	return vm.runInThisContext(`(function(self){return(function(self,global,require,document,exports,Math,Date,setInterval,clearInterval,setTimeout,clearTimeout){${code}\n})(self,self.global,self.require,self.document,self.exports,self.Math,self.Date,self.setInterval,self.clearInterval,self.setTimeout,self.clearTimeout)})`, {
		filename,
		lineOffset: 0,
		displayErrors: true,
	}) as (global: any) => void;
}

const diagnosticsHost = {
	getCurrentDirectory: cwd,
	getCanonicalFileName(fileName: string) {
		return fileName;
	},
	getNewLine() {
		return "\n";
	},
};

type ModuleInitializer = (global: any) => void;

const declarationPattern = /\.d\.ts$/;

export class ServerCompiler {
	private initializerForCode = memoize(sandbox);
	private initializersForPaths = new Map<string, ModuleInitializer | undefined>();
	private languageService: ts.LanguageService;
	private host: ts.LanguageServiceHost & ts.ModuleResolutionHost;
	private program: ts.Program;
	private resolutionCache: ts.ModuleResolutionCache;

	constructor(mainFile: string, private moduleMap: ModuleMap, private staticAssets: StaticAssets, public virtualModule: (path: string) => VirtualModule | void, fileRead: (path: string) => void) {
		// Hijack TypeScript's file access so that we can instrument when it reads files for watching and to inject virtual modules
		fileRead = memoize(fileRead);
		const fileNames = [/*packageRelative("dist/common/preact.d.ts"), */packageRelative("types/reduced-dom.d.ts"), mainFile];
		function readFile(path: string, encoding?: string) {
			if (declarationPattern.test(path)) {
				const module = virtualModule(path.replace(declarationPattern, ""));
				if (module) {
					return module.generateTypeDeclaration();
				}
			}
			fileRead(path);
			return ts.sys.readFile(path, encoding);
		}
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
		const initializer = this.initializerForSource(source);
		if (!initializer) {
			throw new Error("Unable to find module: " + source.path);
		}
		const moduleGlobal: ServerModuleGlobal & any = Object.create(global);
		Object.assign(moduleGlobal, globalProperties);
		moduleGlobal.self = moduleGlobal;
		moduleGlobal.global = global;
		moduleGlobal.require = require;
		moduleGlobal.module = module;
		moduleGlobal.exports = module.exports;
		initializer(moduleGlobal);
	}

	public initializerForSource(source: ModuleSource) {
		return source.from === "file" ? this.initializerForPath(source.path) : this.initializerForCode(source.code, "__bundle.js");
	}

	public initializerForPath(path: string): ModuleInitializer | undefined {
		if (this.initializersForPaths.has(path)) {
			return this.initializersForPaths.get(path);
		}
		// Check for declarations
		if (declarationPattern.test(path)) {
			const module = this.virtualModule(path.replace(declarationPattern, ""));
			if (module) {
				const instantiate = module.instantiateModule(this.program, this.moduleMap, this.staticAssets);
				this.initializersForPaths.set(path, instantiate);
				return instantiate;
			}
		}
		// Verify that TypeScript knows about this path
		if (!this.program.getSourceFile(path)) {
			this.initializersForPaths.set(path, undefined);
			return undefined;
		}
		// Extract compiled output and source map from TypeScript
		let scriptContents: string | undefined;
		let scriptMap: string | undefined;
		for (const { name, text } of this.languageService.getEmitOutput(path).outputFiles) {
			if (/\.js$/.test(name)) {
				scriptContents = text;
			} else if (/\.js\.map$/.test(name)) {
				scriptMap = text;
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
		const transformed = babel.transform(typeof scriptContents === "string" ? scriptContents : readFileSync(path.replace(/\.d\.ts$/, ".js")).toString(), {
			babelrc: false,
			plugins: [
				dynamicImport,
				rewriteDynamicImport,
				convertToCommonJS,
				[transformAsyncToPromises(babel), { externalHelpers: false }],
				optimizeClosuresInRender,
				rewriteForInStatements(),
				noImpureGetters(),
			],
			inputSourceMap: typeof scriptMap === "string" ? JSON.parse(scriptMap) : undefined,
		});
		// Wrap in the sandbox JavaScript
		const result = sandbox(transformed.code!, path);
		this.initializersForPaths.set(path, result);
		return result;
	}
}
