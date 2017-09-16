import includePaths from "rollup-plugin-includepaths";
import babel from "rollup-plugin-babel";
import { types } from "babel-core";
import { pureBabylon as pure } from "side-effects-safe";

function stripRedact() {
	const stripFunctionNameList = ["redact"];
	return {
		visitor: {
			CallExpression(path) {
				const calleePath = path.get("callee");
				const isMatched = stripFunctionNameList.some((fnName) => {
					if (calleePath.matchesPattern(fnName)) {
						return !calleePath.node.computed;
					}
					return calleePath.node.name === fnName;
				});
				if (isMatched && path.node.arguments.length != 0) {
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

export default {
	entry: "src/app.js",
	dest: "public/client.js",
	format: "iife",
	plugins: [
		includePaths({
			include: {
				"preact": "preact/dist/preact.esm.js"
			},
			paths: ["src", "common", "client", "preact/dist"]
		}),
		babel({
			babelrc: false,
			plugins: [stripRedact()]
		})
	]
};
