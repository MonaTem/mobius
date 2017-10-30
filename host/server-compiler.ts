import * as babel from "babel-core";
import { readFileSync } from "fs";
import * as ts from "typescript";
import * as vm from "vm";
import { cwd } from "process";
import addSubresourceIntegrity from "./addSubresourceIntegrity";
import { packageRelative } from "./fileUtils";
import memoize from "./memoize";
import noImpureGetters from "./noImpureGetters";
import rewriteForInStatements from "./rewriteForInStatements";
import verifyStylePaths from "./verify-style-paths";

let convertToCommonJS: any;
let optimizeClosuresInRender: any;

export interface ServerModule {
	exports: any;
	paths: string[];
}

interface ServerModuleGlobal {
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

export type ModuleSource = { from: "file", path: string } | { from: "string", code: string };

const compilerOptions = (() => {
	const fileName = "tsconfig-server.json";
	const configFile = ts.readJsonConfigFile(packageRelative(fileName), (path: string) => readFileSync(path).toString());
	const configObject = ts.convertToObject(configFile, []);
	return ts.convertCompilerOptionsFromJson(configObject.compilerOptions, packageRelative("./"), fileName).options;
})();

function sandbox<T extends ServerModuleGlobal>(code: string, filename: string): (global: T) => void {
	return vm.runInThisContext(`(function(self){return(function(self,global,require,document,exports,Math,Date,setInterval,clearInterval,setTimeout,clearTimeout){${code}\n})(self,self.global,self.require,self.document,self.exports,self.Math,self.Date,self.setInterval,self.clearInterval,self.setTimeout,self.clearTimeout)})`, {
		filename,
		lineOffset: 0,
		displayErrors: true,
	}) as (global: T) => void;
}

const diagnosticsHost = {
	getCurrentDirectory: cwd,
	getCanonicalFileName(fileName: string) {
		return fileName;
	},
	getNewLine() {
		return "\n";
	}
};

const sandboxedScriptAtPath = memoize(<T extends ServerModuleGlobal>(path: string, publicPath: string) => {
	if (!convertToCommonJS) {
		convertToCommonJS = require("babel-plugin-transform-es2015-modules-commonjs")();
	}
	if (!optimizeClosuresInRender) {
		optimizeClosuresInRender = require("babel-plugin-optimize-closures-in-render")(babel);
	}
	let scriptContents: string | undefined;
	let scriptMap: string | undefined;
	const isTypeScript = /\.ts(|x)$/.test(path);
	if (isTypeScript) {
		const program = ts.createProgram([path, packageRelative("types/reduced-dom.d.ts")], compilerOptions);
		const diagnostics = ts.getPreEmitDiagnostics(program);
		if (diagnostics.length) {
			console.log(ts.formatDiagnostics(diagnostics, diagnosticsHost));
		}
		for (let sourceFile of program.getSourceFiles()) {
			if (sourceFile.fileName === path) {
				program.emit(sourceFile, (fileName: string, data: string, writeByteOrderMark: boolean, onError?: (message: string) => void, sourceFiles?: ReadonlyArray<ts.SourceFile>) => {
					if (/\.js$/.test(fileName)) {
						scriptContents = data;
					} else if (/\.js\.map$/.test(fileName)) {
						scriptMap = data;
					}
				});
			}
		}
	}
	const transformed = babel.transform(typeof scriptContents === "string" ? scriptContents : readFileSync(path).toString(), {
		babelrc: false,
		plugins: [
			convertToCommonJS,
			optimizeClosuresInRender,
			addSubresourceIntegrity(publicPath),
			verifyStylePaths(publicPath),
			rewriteForInStatements(),
			noImpureGetters(),
		],
		inputSourceMap: typeof scriptMap === "string" ? JSON.parse(scriptMap) : undefined,
	});
	return sandbox<T>(transformed.code!, path);
});

const sandboxedScriptFromCode = memoize(sandbox);

export function loadModule<T>(source: ModuleSource, module: ServerModule, publicPath: string, globalProperties: T, require: (name: string) => any) {
	const moduleGlobal: ServerModuleGlobal & T = Object.create(global);
	Object.assign(moduleGlobal, globalProperties);
	moduleGlobal.self = moduleGlobal;
	moduleGlobal.global = global;
	moduleGlobal.require = require;
	moduleGlobal.module = module;
	moduleGlobal.exports = module.exports;
	if (source.from === "file") {
		sandboxedScriptAtPath(source.path, publicPath)(moduleGlobal);
	} else {
		sandboxedScriptFromCode(source.code, "__bundle.js")(moduleGlobal);
	}
}
