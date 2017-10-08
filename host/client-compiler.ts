import * as path from "path";
import { rollup, Plugin } from "rollup";
import { NodePath } from "babel-traverse";
import { CallExpression, Identifier, ImportDeclaration, ImportSpecifier, Node, LogicalExpression } from "babel-types";
import * as babel from "babel-core";
import * as types from "babel-types";
import { pureBabylon as pure } from "side-effects-safe";
import _rollupBabel from "rollup-plugin-babel";
import _includePaths from "rollup-plugin-includepaths";
import _rollupTypeScript from "rollup-plugin-typescript2";

const includePaths = require("rollup-plugin-includepaths") as typeof _includePaths;
const rollupBabel = require("rollup-plugin-babel") as typeof _rollupBabel;
const rollupTypeScript = require("rollup-plugin-typescript2") as typeof _rollupTypeScript;
const rewriteForInStatements = require("../../rewriteForInStatements");

// true to error on non-pure, false to evaluate anyway, undefined to ignore
type RedactedExportData = { [exportName: string]: (boolean | undefined)[] };
const redactions: { [moduleName: string]: RedactedExportData } = {
	"redact": {
		"redact": [true],
	},
	"sql": {
		"query": [true, true, false],
		"modify": [true, true, false],
	},
	"sql-impl": {
		"execute": [true, true, false],
	},
	"fetch": {
		"fromServer": [false, false],
	},
	"broadcast": {
		"send": [false, false],
		"receive": [false]
	}
};

function importBindingForPath(path: NodePath<CallExpression>) : { module: string, export: string } | undefined {
	const callee = path.node.callee;
	if (callee.type == "Identifier") {
		const binding = path.scope.getBinding(callee.name);
		if (binding && binding.path.isImportSpecifier() &&
			(binding.path.node as ImportSpecifier).imported.type == "Identifier" &&
			binding.path.parent.type == "ImportDeclaration" &&
			(binding.path.parent as ImportDeclaration).source.type == "StringLiteral")
		{
			return {
				module: (binding.path.parent as ImportDeclaration).source.value,
				export: (binding.path.node as ImportSpecifier).imported.name
			};
		}
	} else if (callee.type == "MemberExpression" && callee.object.type == "Identifier") {
		const binding = path.scope.getBinding(callee.object.name);
		if (binding && binding.path.isImportNamespaceSpecifier() && (binding.path.parent as ImportDeclaration).source.type == "StringLiteral") {
			return {
				module: (binding.path.parent as ImportDeclaration).source.value,
				export: (callee.property as Identifier).name
			};
		}
	}
}

function isUndefined(node: Node) {
	return node.type == "Identifier" && (node as Identifier).name === "undefined";
}

function isPureOrRedacted(path: NodePath) {
	if (pure(path.node, { pureMembers: /./ })) {
		return true;
	}
	if (path.isCallExpression()) {
		const binding = importBindingForPath(path as NodePath<CallExpression>);
		if (binding) {
			return binding.module === "redact" && binding.export === "redact";
		}
	}
	return false;
}

function stripRedact() {
	return {
		visitor: {
			CallExpression: {
				exit(path: NodePath<CallExpression>) {
					const binding = importBindingForPath(path);
					if (binding) {
						const moduleRedactions = redactions[binding.module];
						if (moduleRedactions) {
							const methodRedactions = moduleRedactions[binding.export];
							if (methodRedactions) {
								const mappedArguments = path.node.arguments.map((arg, index) => {
									const isPure = isPureOrRedacted(path.get(`arguments.${index}`));
									switch (methodRedactions[index]) {
										case true:
											if (isPure) {
												return types.identifier("undefined");
											}
											throw path.buildCodeFrameError(`Potential side-effects in argument ${index+1} to ${binding.export} from ${binding.module} in ${path.getSource()}, where only pure expression was expected!`);
										case false:
											if (isPure) {
												return types.identifier("undefined");
											}
											return arg;
										default:
											return arg;
									}
								});
								while (mappedArguments.length && isUndefined(mappedArguments[mappedArguments.length-1])) {
									mappedArguments.pop();
								}
								path.replaceWith(types.callExpression(path.node.callee, mappedArguments));
								path.skip();
							}
						}
					}
				}
			}
		}
	};
}

function fixTypeScriptExtendsWarning() {
	return {
		visitor: {
			LogicalExpression: {
				exit(path: NodePath<LogicalExpression>) {
					const node = path.node;
					const left = node.left;
					if (node.operator == "||" && left.type == "LogicalExpression" && left.operator == "&&" && left.left.type == "ThisExpression") {
						const right = left.right;
						if (right.type == "MemberExpression" && right.object.type == "ThisExpression" && right.property.type == "Identifier" && /^__/.test(right.property.name)) {
							path.replaceWith(node.right);
						}
					}
				}
			}
		}
	};
}

export default async function(input: string, basePath: string) : Promise<string> {
	const bundle = await rollup({
		input: path.join(basePath, input),
		plugins: [
			includePaths({
				include: {
					"preact": path.join(__dirname, "../../node_modules/preact/dist/preact.esm.js")
				},
			}),
			rollupTypeScript({
				tsconfig: path.join(__dirname, "../../tsconfig.json"),
				tsconfigOverride: {
					compilerOptions: {
						baseUrl: basePath,
						paths: {
							"*": [
								path.join(__dirname, "../../client/*"),
								path.join(__dirname, "../../common/*"),
								path.join(__dirname, "../../types/*")
							]
						}
					}
				}
			}) as any as Plugin,
			rollupBabel({
				babelrc: false,
				plugins: [stripRedact(), rewriteForInStatements(babel), fixTypeScriptExtendsWarning()]
			})
		]
	});
	const output = await bundle.generate({
		format: "iife"
	});
	return output.code;
}

