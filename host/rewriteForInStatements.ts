import { NodePath } from "babel-traverse";
import { CallExpression, ForInStatement, Identifier, LabeledStatement, Program, VariableDeclarator } from "babel-types";
import * as types from "babel-types";

export default function() {
	let requiresSortHelper = false;
	let requiresForInHelper = false;
	const template = require("babel-template");
	return {
		visitor: {
			// Rewrite for (... in ...) into the equivalent source that iterates in a well-defined order
			ForInStatement: {
				exit(path: NodePath<ForInStatement>) {
					let ancestor: NodePath = path;
					while (ancestor = ancestor.parentPath) {
						if (ancestor.isLabeledStatement() && (ancestor.node as LabeledStatement).label.name === "ignore_nondeterminism") {
							return;
						}
						if (ancestor.isVariableDeclarator() && ancestor.get("id").isIdentifier() && ((ancestor.node as VariableDeclarator).id as Identifier).name == "__extends") {
							return;
						}
					}
					const node = path.node;
					const keysIdentifier = path.scope.generateUidIdentifier("keys");
					const iIdentifier = path.scope.generateUidIdentifier("i");
					const keysSubIExpression = types.memberExpression(keysIdentifier, iIdentifier, true);
					const body = node.body.type == "BlockStatement" ? node.body.body.slice() : [node.body];
					if (node.left.type == "VariableDeclaration") {
						body.unshift(types.variableDeclaration(node.left.kind, [types.variableDeclarator(node.left.declarations[0].id, keysSubIExpression)]));
					} else {
						body.unshift(types.expressionStatement(types.assignmentExpression("=", node.left, keysSubIExpression)));
					}
					path.replaceWith(types.forStatement(
						types.variableDeclaration("var", [
							types.variableDeclarator(keysIdentifier, types.callExpression(types.identifier("__enumerate_props"), [node.right])),
							types.variableDeclarator(iIdentifier, types.numericLiteral(0)),
						]),
						types.binaryExpression("<", iIdentifier, types.memberExpression(keysIdentifier, types.identifier("length"))),
						types.unaryExpression("++", iIdentifier),
						types.blockStatement(body)),
					);
					path.addComment("leading", "Deterministic for (... in ...)");
					path.skip();
					requiresForInHelper = true;
				},
			},
			// Rewrite Object.keys(...) into Object.keys(...).sort(__sort_keys)
			CallExpression: {
				exit(path: NodePath<CallExpression>) {
					const node = path.node;
					const callee = node.callee;
					if (callee.type == "MemberExpression" && callee.object.type == "Identifier" && callee.object.name == "Object") {
						if (callee.property.type == "Identifier" && callee.property.name == "keys") {
							path.replaceWith(types.callExpression(types.memberExpression(node, types.identifier("sort")), [types.identifier("__sort_keys")]));
							path.addComment("leading", "Deterministic Object.keys(...)");
							path.skip();
							requiresSortHelper = true;
						}
					}
				},
			},
			Program: {
				exit(path: NodePath<Program>) {
					const body = path.get("body.0");
					if (requiresForInHelper) {
						body.insertBefore(template(`function __enumerate_props(o) {
							var result = [];
							for (var i in o) {
								result.push(i);
							}
							return result.sort(__sort_keys);
						}`)());
						requiresSortHelper = true;
					}
					if (requiresSortHelper) {
						body.insertBefore(template(`var __is_numeric = /^\\d+$/; function __sort_keys(a, b) {
							var a_numeric = __is_numeric.test(a), b_numeric = __is_numeric.test(b);
							if (a_numeric) {
								return b_numeric ? a - b : -1;
							} else if (b_numeric) {
								return 1;
							} else {
								return a < b ? -1 : a > b ? 1 : 0;
							}
						}`)());
					}
					path.stop();
				},
			},
		},
	};
}
