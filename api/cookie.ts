namespace concurrence {
	export namespace cookie {
		export function get(key: string) : Promise<string | undefined> {
			return concurrence.cookie.all().then(all => Object.hasOwnProperty.call(all, key) ? all[key] : undefined);
		}
	}
}
