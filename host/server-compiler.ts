import * as babel from "babel-core";
import { readFileSync } from "fs";
import * as ts from "typescript";
import * as vm from "vm";
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
	return vm.runInThisContext("(function (self){with(self){return(function(self,global,require,document){" + code + "\n})(self,self.global,self.require,self.document)}})", {
		filename,
		lineOffset: 0,
		displayErrors: true,
	}) as (global: T) => void;
}

const sandboxedScriptAtPath = memoize(<T extends ServerModuleGlobal>(path: string, publicPath: string) => {
	if (!convertToCommonJS) {
		convertToCommonJS = require("babel-plugin-transform-es2015-modules-commonjs")();
	}
	if (!optimizeClosuresInRender) {
		optimizeClosuresInRender = require("babel-plugin-optimize-closures-in-render")(babel);
	}
	const scriptContents = readFileSync(path).toString();
	const compiled = /\.(j|t)s(|x)$/.test(path) ? ts.transpileModule(scriptContents, {
		fileName: path,
		compilerOptions,
	}) : undefined;
	const transformed = babel.transform(compiled ? compiled.outputText : scriptContents, {
		babelrc: false,
		plugins: [
			convertToCommonJS,
			optimizeClosuresInRender,
			addSubresourceIntegrity(publicPath),
			verifyStylePaths(publicPath),
			rewriteForInStatements(),
			noImpureGetters(),
		],
		inputSourceMap: compiled && typeof compiled.sourceMapText == "string" ? JSON.parse(compiled.sourceMapText) : undefined,
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
