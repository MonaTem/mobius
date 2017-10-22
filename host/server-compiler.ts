import * as vm from "vm";
import { readFileSync } from "fs";
import memoize from "./memoize";
import * as ts from "typescript";
import { packageRelative } from "./fileUtils";
import * as babel from "babel-core";
import rewriteForInStatements from "./rewriteForInStatements";
import noImpureGetters from "./noImpureGetters";

let convertToCommonJS: any;
let optimizeClosuresInRender: any;

export interface ServerModule {
	exports: any,
	paths: string[]
}

interface ServerModuleGlobal {
	self: this,
	global: this | NodeJS.Global,
	require: (name: string) => any,
	module: ServerModule,
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
	const fileName = "tsconfig-server.json";
	const configFile = ts.readJsonConfigFile(packageRelative(fileName), (path: string) => readFileSync(path).toString());
	const configObject = ts.convertToObject(configFile, []);
	return ts.convertCompilerOptionsFromJson(configObject.compilerOptions, packageRelative("./"), fileName).options;
})();

const sandboxedScriptAtPath = memoize(<T extends ServerModuleGlobal>(scriptPath: string) => {
	if (!convertToCommonJS) {
		convertToCommonJS = require("babel-plugin-transform-es2015-modules-commonjs");
	}
	if (!optimizeClosuresInRender) {
		optimizeClosuresInRender = require("babel-plugin-optimize-closures-in-render");
	}
	const scriptContents = readFileSync(scriptPath).toString();
	const compiled = /\.(j|t)s(|x)$/.test(scriptPath) ? ts.transpileModule(scriptContents, {
		fileName: scriptPath,
		compilerOptions
	}) : undefined;
	const transformed = babel.transform(compiled ? compiled.outputText : scriptContents, {
		babelrc: false,
		plugins: [
			convertToCommonJS(),
			optimizeClosuresInRender(babel),
			rewriteForInStatements(),
			noImpureGetters(),
		],
		inputSourceMap: compiled && typeof compiled.sourceMapText == "string" ? JSON.parse(compiled.sourceMapText) : undefined
	});
	return vm.runInThisContext("(function (self){with(self){return(function(self,global,require,document,request){" + transformed.code + "\n})(self,self.global,self.require,self.document,self.request)}})", {
		filename: scriptPath,
		lineOffset: 0,
		displayErrors: true
	}) as (global: T) => void;
});

export function loadModule<T>(path: string, module: ServerModule, globalProperties: T, require: (name: string) => any) {
	const moduleGlobal: ServerModuleGlobal & T = Object.create(global);
	Object.assign(moduleGlobal, globalProperties);
	moduleGlobal.self = moduleGlobal;
	moduleGlobal.global = global;
	moduleGlobal.require = require;
	moduleGlobal.module = module;
	moduleGlobal.exports = module.exports;
	sandboxedScriptAtPath(path)(moduleGlobal);
}
