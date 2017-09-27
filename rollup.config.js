import includePaths from "rollup-plugin-includepaths";
import rollupBabel from "rollup-plugin-babel";
import babel from "babel-core";
import { pureBabylon as pure } from "side-effects-safe";

const rewriteForInStatements = require("./rewriteForInStatements");

const types = babel.types;

// true to error on non-pure, false to evaluate anyway, undefined to ignore
const redactions = {
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

function importBindingForPath(path) {
	if (path.isCallExpression()) {
		const callee = path.node.callee;
		if (callee.type == "Identifier") {
			const binding = path.scope.getBinding(callee.name);
			if (binding && binding.path.isImportSpecifier() && binding.path.node.imported.type == "Identifier" && binding.path.parent.type == "ImportDeclaration" && binding.path.parent.source.type == "StringLiteral") {
				return {
					module: binding.path.parent.source.value,
					export: binding.path.node.imported.name
				};
			}
		} else if (callee.type == "MemberExpression" && callee.object.type == "Identifier") {
			const binding = path.scope.getBinding(callee.object.name);
			if (binding && binding.path.node.type == "ImportNamespaceSpecifier" && binding.path.parent.source.type == "StringLiteral") {
				return {
					module: binding.path.parent.source.value,
					export: callee.property.name
				};
			}
		}
	}
}

function isUndefined(node) {
	return node.type == "Identifier" && node.name === "undefined";
}

function isPureOrRedacted(path) {
	if (pure(path.node, { pureMembers: /./ })) {
		return true;
	}
	const binding = importBindingForPath(path);
	if (binding) {
		return binding.module === "redact" && binding.export === "redact";
	}
	return false;
}

function stripRedact() {
	return {
		visitor: {
			CallExpression: {
				exit(path) {
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
				exit(path) {
					const node = path.node;
					const left = node.left;
					if (node.operator == "||" && left.type == "LogicalExpression" && left.operator == "&&" && left.left.type == "ThisExpression") {
						const right = left.right;
						if (right.type == "MemberExpression" && right.object.type == "ThisExpression" && right.property.type == "Identifier" && right.property.name == "__extends") {
							path.replaceWith(node.right);
						}
					}
				}
			}
		}
	};
}

export default {
	input: "build/.client/src/app.js",
	output: {
		file: "build/src/client.js",
		format: "iife"
	},
	plugins: [
		includePaths({
			include: {
				"preact": "preact/dist/preact.esm.js"
			},
			paths: ["build/.client/src", "build/.client/common", "build/.client/client", "preact/dist"]
		}),
		rollupBabel({
			babelrc: false,
			plugins: [stripRedact(), rewriteForInStatements(babel), fixTypeScriptExtendsWarning()]
		})
	]
};
