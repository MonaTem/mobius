import * as vm from "vm";
import { readFileSync } from "fs";

const enum SandboxMode {
	Simple = 0,
	Full = 1,
};

const sandboxMode = SandboxMode.Simple as SandboxMode;

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
};

const sandboxedScriptAtPath = memoize(<T extends SandboxGlobal>(scriptPath: string) => {
	const scriptContents = readFileSync(scriptPath).toString();
	if (sandboxMode == SandboxMode.Full) {
		// Full sandboxing, creating a new global context each time
		const vmScript = new vm.Script(scriptContents, {
			filename: scriptPath,
			lineOffset: 0,
			displayErrors: true
		});
		return vmScript.runInNewContext.bind(vmScript) as (global: T) => void;
	} else {
		// Simple sandboxing, relying on function scope
		const context = {
			app: (global: T) => {
			},
		};
		vm.runInNewContext("function app(self){with(self){return(function(self,global,require,document,request){" + scriptContents + "\n})(self,self.global,self.require,self.document,self.request)}}", context, {
			filename: scriptPath,
			lineOffset: 0,
			displayErrors: true
		});
		const result = context.app;
		delete context.app;
		return result;
	}
});

function memoize<I, O>(func: (input: I) => O) {
	const values = new Map<I, O>();
	return (input: I) => {
		if (values.has(input)) {
			return values.get(input) as O;
		}
		const result = func(input);
		values.set(input, result);
		return result;
	}
}

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
