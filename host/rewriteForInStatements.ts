import { NodePath } from "babel-traverse";
import { CallExpression, ForInStatement, Identifier, LabeledStatement, VariableDeclarator } from "babel-types";
import * as types from "babel-types";

export default function() {
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
					const rightIdentifier = path.scope.generateUidIdentifier("right");
					const keyIdentifier = path.scope.generateUidIdentifier("key");
					const keysIdentifier = path.scope.generateUidIdentifier("keys");
					const iIdentifier = path.scope.generateUidIdentifier("i");
					const keysSubIExpression = types.memberExpression(keysIdentifier, iIdentifier, true);
					const body = node.body.type == "BlockStatement" ? node.body.body.slice() : [node.body];
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
				exit(path: NodePath<CallExpression>) {
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
