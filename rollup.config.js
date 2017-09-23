import includePaths from "rollup-plugin-includepaths";
import babel from "rollup-plugin-babel";
import { types } from "babel-core";
import { pureBabylon as pure } from "side-effects-safe";

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

function rewriteForInStatements() {
	return {
		visitor: {
			// Rewrite for (... in ...) into the equivalent source that iterates in a well-defined order
			ForInStatement: {
				exit(path) {
					const node = path.node;
					const rightIdentifier = path.scope.generateUidIdentifier("right");
					const keyIdentifier = path.scope.generateUidIdentifier("key");
					const keysIdentifier = path.scope.generateUidIdentifier("keys");
					const iIdentifier = path.scope.generateUidIdentifier("i");
					const keysSubIExpression = types.memberExpression(keysIdentifier, iIdentifier, true);
					const body = node.body.type == "BlockStatement" ? node.body.body.slice() : [];
					if (node.left.type == "VariableDeclaration") {
						body.unshift(types.variableDeclaration(node.left.kind, [types.variableDeclarator(node.left.declarations[0].id, keysSubIExpression)]));
					} else {
						body.unshift(types.expressionStatement(types.assignmentExpression("=", node.left, keysSubIExpression)));
					}
					path.replaceWith(types.blockStatement([
						types.variableDeclaration("var", [
							types.variableDeclarator(rightIdentifier, node.right),
							types.variableDeclarator(keyIdentifier),
							types.variableDeclarator(keysIdentifier, types.arrayExpression([])),
							types.variableDeclarator(iIdentifier, types.numericLiteral(0)),
						]),
						types.forInStatement(keyIdentifier, rightIdentifier, types.expressionStatement(types.callExpression(types.memberExpression(keysIdentifier, types.identifier("push")), [keyIdentifier]))),
						types.forStatement(types.callExpression(types.memberExpression(keysIdentifier, types.identifier("sort")), []), types.binaryExpression("<", iIdentifier, types.memberExpression(keysIdentifier, types.identifier("length"))), types.unaryExpression("++", iIdentifier), types.blockStatement(body)),
					]));
					path.addComment("leading", "Deterministic for (... in ...)");
					path.skip();
				}
			},
			// Rewrite Object.keys(...) into Object.keys(...).sort()
			CallExpression: {
				exit(path) {
					const node = path.node;
					const callee = node.callee;
					if (callee.type == "MemberExpression" && callee.object.type == "Identifier" && callee.object.name == "Object") {
						if (callee.property.type == "Identifier" && callee.property.name == "keys") {
							path.replaceWith(types.callExpression(types.memberExpression(node, types.identifier("sort")), []));
							path.addComment("leading", "Deterministic Object.keys(...)");
							path.skip();
						}
					}
				}
			}
		}
	}
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
			plugins: [stripRedact(), rewriteForInStatements()]
		})
	]
};
