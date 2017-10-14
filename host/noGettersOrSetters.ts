import { NodePath } from "babel-traverse";
import { ClassMethod, ObjectMethod } from "babel-types";

function verifyMethodType(path: NodePath<ClassMethod> | NodePath<ObjectMethod>) {
	switch (path.node.kind) {
		case "get":
			throw path.buildCodeFrameError("Getter methods are not supported by all browsers and may introduce non-determinism!");
		case "set":
			throw path.buildCodeFrameError("Setter methods are not supported by all browsers!");
	}
}

export default function() {
	return {
		visitor: {
			ClassMethod: verifyMethodType,
			ObjectMethod: verifyMethodType
		}
	}
}
