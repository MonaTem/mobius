import * as vm from "vm";
import { readFileSync } from "fs";
import memoize from "./memoize";
import * as ts from "typescript";
import * as path from "path";
import * as babel from "babel-core";

const rewriteForInStatements = require("../../rewriteForInStatements");

export interface SandboxModule {
	exports: any,
	paths: string[]
}

interface SandboxGlobal {
	self: this,
	global: this | NodeJS.Global,
	require: (name: string) => any,
	module: SandboxModule,
	exports: any,
	Object?: typeof Object,
	Array?: typeof Array
};

declare global {
	namespace NodeJS {
		export interface Global {
			newModule?: (global: any) => void;
		}
	}
}

const compilerOptions = (() => {
	const basePath = path.join(__dirname, "../..");
	const fileName = "tsconfig-server.json";
	const configFile = ts.readJsonConfigFile(path.join(basePath, fileName), (path: string) => readFileSync(path).toString());
	const configObject = ts.convertToObject(configFile, []);
	return ts.convertCompilerOptionsFromJson(configObject.compilerOptions, basePath, fileName).options;
})();

const sandboxedScriptAtPath = memoize(<T extends SandboxGlobal>(scriptPath: string) => {
	const scriptContents = readFileSync(scriptPath).toString();
	const compiled = ts.transpileModule(scriptContents, {
		fileName: scriptPath,
		compilerOptions
	});
	const transformed = babel.transform(compiled.outputText, {
		babelrc: false,
		plugins: [rewriteForInStatements(babel)],
		inputSourceMap: typeof compiled.sourceMapText == "string" ? JSON.parse(compiled.sourceMapText) : undefined
	});
	return vm.runInThisContext("(function (self){with(self){return(function(self,global,require,document,request){" + transformed.code + "\n})(self,self.global,self.require,self.document,self.request)}})", {
		filename: scriptPath,
		lineOffset: 0,
		displayErrors: true
	}) as (global: T) => void;
});

export function loadModule<T>(path: string, module: SandboxModule, globalProperties: T, require: (name: string) => any) {
	const moduleGlobal: SandboxGlobal & T = Object.create(global);
	Object.assign(moduleGlobal, globalProperties);
	moduleGlobal.self = moduleGlobal;
	moduleGlobal.global = global;
	moduleGlobal.require = require;
	moduleGlobal.module = module;
	moduleGlobal.exports = module.exports;
	sandboxedScriptAtPath(path)(moduleGlobal);
}
