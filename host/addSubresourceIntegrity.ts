import { NodePath } from "babel-traverse";
import { CallExpression, StringLiteral } from "babel-types";
import * as types from "babel-types";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import importBindingForCall from "./importBindingForCall";

export default function(basePath: string, fileRead: (path: string) => void) {
	return {
		visitor: {
			CallExpression(path: NodePath<CallExpression>) {
				const binding = importBindingForCall(path);
				if (binding && binding.module === "dom" && binding.export === "style") {
					if (path.node.arguments.length === 1) {
						const firstArg = path.get("arguments.0");
						if (firstArg.isStringLiteral()) {
							const value = (firstArg.node as StringLiteral).value;
							if (!/^\w+:/.test(value)) {
								const filePath = resolve(basePath, value);
								fileRead(filePath);
								const fileContents = readFileSync(filePath);
								const hash = createHash("sha256").update(fileContents).digest("base64");
								path.node.arguments.push(types.stringLiteral("sha256-" + hash));
							}
						}
					}
				}
			},
		},
	};
}
