import { NodePath } from "babel-traverse";
import { ClassMethod, ObjectMethod } from "babel-types";
import { pureBabylon as pure } from "side-effects-safe";

function verifyPurityOfGetters(path: NodePath<ClassMethod> | NodePath<ObjectMethod>) {
	if (path.node.kind === "get" && !pure(path.node.body, { pureMembers: /./ })) {
		throw path.buildCodeFrameError("Impure getter methods may introduce non-determinism as a result of optimization!");
	}
}

export default function() {
	return {
		visitor: {
			ClassMethod: verifyPurityOfGetters,
			ObjectMethod: verifyPurityOfGetters
		}
	}
}
