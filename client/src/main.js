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
		// Task 7 smoke: expose the stores on a dedicated pinia instance so the
		// full store flows (login/settings/room sendChat) can be
		// driven from the console against a real backend. Dev-only, tree-shaken.
		Promise.all([
			import('pinia'),
			import('./stores/settingsStore'),
			import('./stores/roomStore'),
			import('./stores/storyStore'),
		]).then(([piniaMod, settings, room, story]) => {
			const { createPinia, setActivePinia } = piniaMod;
			setActivePinia(createPinia());
			window.__stores = {
				settings: settings.useSettingsStore,
				room: room.useRoomStore,
				story: story.useStoryStore,
			};
		});
	}
	return {
		app,
	};
}
