import includePaths from "rollup-plugin-includepaths";
import rollupBabel from "rollup-plugin-babel";
import babel from "babel-core";
import { pureBabylon as pure } from "side-effects-safe";

const rewriteForInStatements = require("./rewriteForInStatements");

const types = babel.types;

function stripRedact() {
	return {
		visitor: {
			CallExpression(path) {
				if (path.get("callee").node.name == "redact" && path.node.arguments.length != 0) {
					if (path.node.arguments.every(node => pure(node, { pureMembers: /./ }))) {
						path.replaceWith(types.callExpression(types.identifier("redact"), []));
					} else {
						throw path.buildCodeFrameError(`Potential side-effects in ${path.getSource()}, where only pure arguments are expected!`);
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
		file: "public/client.js",
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
