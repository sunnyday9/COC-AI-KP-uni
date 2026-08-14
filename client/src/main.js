import {
	createSSRApp
} from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
export function createApp() {
	const app = createSSRApp(App);
	app.use(createPinia());
	// Dev-only: expose the Bridge singleton for console smoke tests
	// (task-6-brief verification #3). Tree-shaken away in production builds.
	if (import.meta.env.DEV && typeof window !== 'undefined') {
		import('./platform/index').then(({ getBridge }) => {
			window.__bridge = getBridge();
		});
	}
	return {
		app,
	};
}
