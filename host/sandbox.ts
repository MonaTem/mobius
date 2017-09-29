import * as vm from "vm";
import { readFileSync } from "fs";
import memoize from "./memoize";

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

const sandboxedScriptAtPath = memoize(<T extends SandboxGlobal>(scriptPath: string) => {
	const scriptContents = readFileSync(scriptPath).toString();
	return vm.runInThisContext("(function (self){with(self){return(function(self,global,require,document,request){" + scriptContents + "\n})(self,self.global,self.require,self.document,self.request)}})", {
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
