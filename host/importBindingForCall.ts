import { CallExpression, Identifier, ImportDeclaration, ImportSpecifier } from "babel-types";
import { NodePath } from "babel-traverse";

export default function importBindingForCall(path: NodePath<CallExpression>) : { module: string, export: string } | undefined {
	const callee = path.node.callee;
	if (callee.type == "Identifier") {
		const binding = path.scope.getBinding(callee.name);
		if (binding && binding.path.isImportSpecifier() &&
			(binding.path.node as ImportSpecifier).imported.type == "Identifier" &&
			binding.path.parent.type == "ImportDeclaration" &&
			(binding.path.parent as ImportDeclaration).source.type == "StringLiteral")
		{
			return {
				module: (binding.path.parent as ImportDeclaration).source.value,
				export: (binding.path.node as ImportSpecifier).imported.name
			};
		}
	} else if (callee.type == "MemberExpression" && callee.object.type == "Identifier") {
		const binding = path.scope.getBinding(callee.object.name);
		if (binding && binding.path.isImportNamespaceSpecifier() && (binding.path.parent as ImportDeclaration).source.type == "StringLiteral") {
			return {
				module: (binding.path.parent as ImportDeclaration).source.value,
				export: (callee.property as Identifier).name
			};
		}
	}
}
