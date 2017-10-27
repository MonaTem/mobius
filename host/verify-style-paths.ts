import { NodePath } from "babel-traverse";
import { CallExpression, StringLiteral } from "babel-types";
import { existsSync } from "fs";
import { resolve } from "path";
import importBindingForCall from "./importBindingForCall";

export default function verifyStylePaths(basePath: string) {
	return {
		visitor: {
			CallExpression: {
				exit(path: NodePath<CallExpression>) {
					const args = path.node.arguments;
					if (args.length === 1 && args[0].type === "StringLiteral") {
						const binding = importBindingForCall(path);
						if (binding && binding.module === "dom" && binding.export === "style") {
							const value = (args[0] as StringLiteral).value;
							if (!/^\w+:/.test(value)) {
								if (!existsSync(resolve(basePath, value.replace(/^\/+/, "")))) {
									throw path.buildCodeFrameError(`Referenced a style path that does not exist: ${path.getSource()}`);
								}
							}
						}
					}
				},
			},
		},
	};
}
