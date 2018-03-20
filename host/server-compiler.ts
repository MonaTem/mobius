import * as babel from "babel-core";
import { readFileSync } from "fs";
import { cwd } from "process";
import * as ts from "typescript";
import * as vm from "vm";
import addSubresourceIntegrity from "./addSubresourceIntegrity";
import { packageRelative } from "./fileUtils";
import memoize from "./memoize";
import noImpureGetters from "./noImpureGetters";
import rewriteDynamicImport from "./rewriteDynamicImport";
import rewriteForInStatements from "./rewriteForInStatements";
import { validationModule } from "./validation-module";
import verifyStylePaths from "./verify-style-paths";

let convertToCommonJS: any;
let optimizeClosuresInRender: any;
let dynamicImport: any;

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

const validatorsPathPattern = /\!validators\.d\.ts$/;
const typescriptExtensions = [".ts", ".tsx", ".d.ts"];

export class ServerCompiler {
	private initializerForCode = memoize(sandbox);
	private initializersForPaths = new Map<string, ModuleInitializer | undefined>();
	private languageService: ts.LanguageService;
	private publicPath: string;
	private host: ts.LanguageServiceHost & ts.ModuleResolutionHost;
	private program: ts.Program;
	private resolutionCache: ts.ModuleResolutionCache;

	public fileRead: (path: string) => void;

	constructor(mainFile: string, publicPath: string, fileRead: (path: string) => void) {
		this.fileRead = fileRead = memoize(fileRead);
		this.publicPath = publicPath;
		const fileNames = [/*packageRelative("dist/common/preact.d.ts"), */packageRelative("types/reduced-dom.d.ts"), mainFile];
		function readFile(fileName: string, encoding?: string) {
			if (validatorsPathPattern.test(fileName)) {
				return validationModule.generateTypeDeclaration(fileName);
			}
			fileRead(fileName);
			return ts.sys.readFile(fileName, encoding);
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
			fileExists(fileName: string) {
				const result = ts.sys.fileExists(fileName);
				if (result) {
					return result;
				}
				if (validatorsPathPattern.test(fileName)) {
					for (const ext of typescriptExtensions) {
						if (ts.sys.fileExists(fileName.replace(validatorsPathPattern, ext))) {
							return true;
						}
					}
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
		if (validatorsPathPattern.test(path)) {
			for (const ext of typescriptExtensions) {
				const parentModulePath = path.replace(validatorsPathPattern, ext);
				const parentSourceFile = this.program.getSourceFile(parentModulePath);
				if (parentSourceFile) {
					const validatorResult = validationModule.instantiateModule(parentModulePath, parentSourceFile, this.program);
					this.initializersForPaths.set(path, validatorResult);
					return validatorResult;
				}
			}
		}
		let scriptContents: string | undefined;
		let scriptMap: string | undefined;
		if (!this.program.getSourceFile(path)) {
			this.initializersForPaths.set(path, undefined);
			return undefined;
		}
		for (const { name, text } of this.languageService.getEmitOutput(path).outputFiles) {
			if (/\.js$/.test(name)) {
				scriptContents = text;
			} else if (/\.js\.map$/.test(name)) {
				scriptMap = text;
			}
		}
		if (!convertToCommonJS) {
			convertToCommonJS = require("babel-plugin-transform-es2015-modules-commonjs")();
		}
		if (!optimizeClosuresInRender) {
			optimizeClosuresInRender = require("babel-plugin-optimize-closures-in-render")(babel);
		}
		if (!dynamicImport) {
			dynamicImport = require("babel-plugin-syntax-dynamic-import")();
		}
		const transformed = babel.transform(typeof scriptContents === "string" ? scriptContents : readFileSync(path.replace(/\.d\.ts$/, ".js")).toString(), {
			babelrc: false,
			plugins: [
				dynamicImport,
				rewriteDynamicImport,
				convertToCommonJS,
				optimizeClosuresInRender,
				addSubresourceIntegrity(this.publicPath, this.fileRead),
				verifyStylePaths(this.publicPath),
				rewriteForInStatements(),
				noImpureGetters(),
			],
			inputSourceMap: typeof scriptMap === "string" ? JSON.parse(scriptMap) : undefined,
		});
		const result = sandbox(transformed.code!, path);
		this.initializersForPaths.set(path, result);
		return result;
	}
}
