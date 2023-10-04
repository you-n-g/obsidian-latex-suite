import { EditorView } from "@codemirror/view";
import { ChangeSet } from "@codemirror/state";
import { startSnippet } from "./codemirror/history";
import { isolateHistory } from "@codemirror/commands";
import { TabstopSpec, tabstopSpecsToTabstopGroups } from "./tabstop";
import { addTabstops, removeTabstop, removeAllTabstops, getTabstopGroupsFromView, getNextTabstopColor } from "./codemirror/tabstops_state_field";
import { clearSnippetQueue, snippetQueueStateField } from "./codemirror/snippet_queue_state_field";
import { SnippetChangeSpec } from "./codemirror/snippet_change_spec";

export function expandSnippets(view: EditorView):boolean {
	const snippetsToExpand = view.state.field(snippetQueueStateField);
	if (snippetsToExpand.length === 0) return false;

	const originalDocLength = view.state.doc.length;

	handleUndoKeypresses(view, snippetsToExpand);

	const tabstopsToAdd = computeTabstops(view, snippetsToExpand, originalDocLength);

	// Insert any tabstops
	if (tabstopsToAdd.length === 0) {
		clearSnippetQueue(view);
		return true;
	}

	markTabstops(view, tabstopsToAdd);
	expandTabstops(view, tabstopsToAdd);

	clearSnippetQueue(view);
	return true;
}

function handleUndoKeypresses(view: EditorView, snippets: SnippetChangeSpec[]) {
	const originalDoc = view.state.doc;
	const originalDocLength = originalDoc.length;

	const keyPresses: {from: number, to: number, insert: string}[] = [];
	for (const snippet of snippets) {
		if (snippet.keyPressed && (snippet.keyPressed.length === 1)) {
			// Use prevChar so that cursors are placed at the end of the added text
			const prevChar = view.state.doc.sliceString(snippet.to-1, snippet.to);

			const from = snippet.to === 0 ? 0 : snippet.to-1;
			keyPresses.push({from: from, to: snippet.to, insert: prevChar + snippet.keyPressed});
		}
	}

	// Insert the keypresses
	// Use isolateHistory to allow users to undo the triggering of a snippet,
	// but keep the text inserted by the trigger key
	view.dispatch({
		changes: keyPresses,
		annotations: isolateHistory.of("full")
	});

	// Undo the keypresses, and insert the replacements
	const undoKeyPresses = ChangeSet.of(keyPresses, originalDocLength).invert(originalDoc);
	const changesAsChangeSet = ChangeSet.of(snippets, originalDocLength);
	const combinedChanges = undoKeyPresses.compose(changesAsChangeSet);

	// Mark the transaction as the beginning of a snippet (for undo/history purposes)
	view.dispatch({
		changes: combinedChanges,
		effects: startSnippet.of(null)
	});
}

function computeTabstops(view: EditorView, snippets: SnippetChangeSpec[], originalDocLength: number) {
	// Find the positions of the cursors in the new document
	const changeSet = ChangeSet.of(snippets, originalDocLength);
	const oldPositions = snippets.map(change => change.from);
	const newPositions = oldPositions.map(pos => changeSet.mapPos(pos));

	const tabstopsToAdd:TabstopSpec[] = [];
	for (let i = 0; i < snippets.length; i++) {
		tabstopsToAdd.push(...snippets[i].getTabstops(view, newPositions[i]));
	}

	return tabstopsToAdd;
}

function markTabstops(view: EditorView, tabstops: TabstopSpec[]) {
	const color = getNextTabstopColor(view);
	const tabstopGroups = tabstopSpecsToTabstopGroups(tabstops, color);

	addTabstops(view, tabstopGroups);
}

function expandTabstops(view: EditorView, tabstops: TabstopSpec[]) {
	// Insert the replacements
	const changes = tabstops.map((tabstop: TabstopSpec) => {
		return {from: tabstop.from, to: tabstop.to, insert: tabstop.replacement}
	});

	view.dispatch({
		changes: changes
	});

	// Select the first tabstop
	const firstGrp = getTabstopGroupsFromView(view)[0];
	firstGrp.select(view, false, true); // "true" here marks the transaction as the end of the snippet (for undo/history purposes)

	removeOnlyTabstop(view);
}

function removeOnlyTabstop(view: EditorView) {
	// Clear all tabstop groups if there's just one remaining
	const currentTabstopGroups = getTabstopGroupsFromView(view);

	if (currentTabstopGroups.length === 1) {
		removeAllTabstops(view);
	}
}

export function isInsideATabstop(view: EditorView):boolean {
	const currentTabstopGroups = getTabstopGroupsFromView(view);

	for (const tabstopGroup of currentTabstopGroups) {
		if (tabstopGroup.containsSelection(view.state.selection)) {
			return true;
		}
	}

	return false;
}

export function consumeAndGotoNextTabstop(view: EditorView): boolean {
	// Check whether there are currently any tabstops
	if (getTabstopGroupsFromView(view).length === 0) return false;

	// Remove the tabstop that we're inside of
	removeTabstop(view);

	// Select the next tabstop
	const oldSel = view.state.selection;
	const nextGrp = getTabstopGroupsFromView(view)[0];

	// If the old tabstop(s) lie within the new tabstop(s), simply move the cursor
	const shouldMoveToEndpoints = nextGrp.containsSelection(oldSel);
	nextGrp.select(view, shouldMoveToEndpoints, false);

	// If we haven't moved, go again
	const newSel = view.state.selection;

	if (oldSel.eq(newSel))
		return consumeAndGotoNextTabstop(view);

	// If this was the last tabstop group waiting to be selected, remove it
	removeOnlyTabstop(view);

	return true;
}
