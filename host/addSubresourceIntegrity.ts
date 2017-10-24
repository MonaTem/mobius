import importBindingForCall from "./importBindingForCall";
import { CallExpression, StringLiteral } from "babel-types";
import { NodePath } from "babel-traverse";
import * as types from "babel-types";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

export default function(basePath: string) {
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
								const fileContents = readFileSync(resolve(basePath, value));
								const hash = createHash("sha256").update(fileContents).digest("base64");
								path.node.arguments.push(types.stringLiteral("sha256-" + hash));
							}
						}
					}
				}
			}
		}
	}
}
