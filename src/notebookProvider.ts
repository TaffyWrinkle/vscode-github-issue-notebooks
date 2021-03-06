/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AbortController from "abort-controller";
import * as vscode from 'vscode';
import { OctokitProvider } from "./octokitProvider";
import { ProjectContainer } from './project';

interface RawNotebookCell {
	language: string;
	value: string;
	kind: vscode.CellKind;
	editable?: boolean;
}

const entityMap: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
	'/': '&#x2F;',
	'`': '&#x60;',
	'=': '&#x3D;'
};

function escapeHtml(string: string) {
	return string.replace(/[&<>"'`=\/]/g, s => entityMap[s]);
}

class NotebookCellExecution {

	private static _tokenPool = 0;
	private static _tokens = new WeakMap<vscode.NotebookCell, number>();

	private readonly _token: number = NotebookCellExecution._tokenPool++;

	private readonly _originalRunState: vscode.NotebookCellRunState | undefined;
	private readonly _startTime: number = Date.now();

	readonly cts = new vscode.CancellationTokenSource();

	constructor(readonly cell: vscode.NotebookCell) {
		NotebookCellExecution._tokens.set(this.cell, this._token);
		this._originalRunState = cell.metadata.runState;
		cell.metadata.runState = vscode.NotebookCellRunState.Running;
		cell.metadata.runStartTime = this._startTime;
	}

	private _isLatest(): boolean {
		// these checks should be provided by VS Code
		return NotebookCellExecution._tokens.get(this.cell) === this._token;
	}

	cancel(): void {
		if (this._isLatest()) {
			this.cts.cancel();
			this.cell.metadata.runState = this._originalRunState;
			NotebookCellExecution._tokens.delete(this.cell);
		}
	}

	resolve(outputs: vscode.CellOutput[], message?: string): void {
		if (this._isLatest()) {
			this.cell.metadata.runState = vscode.NotebookCellRunState.Success;
			this.cell.metadata.lastRunDuration = Date.now() - this._startTime;
			this.cell.metadata.statusMessage = message;
			this.cell.outputs = outputs;
		}
	}

	reject(err: any): void {
		if (this._isLatest()) {
			// print as error
			this.cell.metadata.statusMessage = 'Error';
			this.cell.metadata.lastRunDuration = undefined;
			this.cell.metadata.runState = vscode.NotebookCellRunState.Error;
			this.cell.outputs = [{
				outputKind: vscode.CellOutputKind.Error,
				ename: err instanceof Error && err.name || 'error',
				evalue: err instanceof Error && err.message || JSON.stringify(err, undefined, 4),
				traceback: []
			}];
		}
	}

	dispose() {
		this.cts.dispose();
	}
}

class NotebookDocumentExecution {

	private static _tokenPool = 0;
	private static _tokens = new WeakMap<vscode.NotebookDocument, number>();

	private readonly _token: number = NotebookDocumentExecution._tokenPool++;

	private readonly _originalRunState: vscode.NotebookRunState | undefined;

	readonly cts = new vscode.CancellationTokenSource();

	constructor(readonly document: vscode.NotebookDocument) {
		NotebookDocumentExecution._tokens.set(this.document, this._token);
		this._originalRunState = document.metadata.runState;
		document.metadata.runState = vscode.NotebookRunState.Running;
	}

	private _isLatest(): boolean {
		// these checks should be provided by VS Code
		return NotebookDocumentExecution._tokens.get(this.document) === this._token;
	}

	cancel(): void {
		if (this._isLatest()) {
			this.cts.cancel();
			this.document.metadata.runState = this._originalRunState;
			NotebookDocumentExecution._tokens.delete(this.document);
		}
	}

	resolve(): void {
		if (this._isLatest()) {
			this.document.metadata.runState = vscode.NotebookRunState.Idle;
		}
	}

	dispose(): void {
		this.cts.dispose();
	}
}

export class IssuesNotebookProvider implements vscode.NotebookContentProvider, vscode.NotebookKernel {
	readonly id = 'githubIssueKernel';
	label: string = 'GitHub Issues Kernel';

	private readonly _onDidChangeNotebook = new vscode.EventEmitter<vscode.NotebookDocumentEditEvent>();
	readonly onDidChangeNotebook: vscode.Event<vscode.NotebookDocumentEditEvent> = this._onDidChangeNotebook.event;

	private readonly _localDisposables: vscode.Disposable[] = [];
	// kernel: vscode.NotebookKernel;

	private readonly _cellExecutions = new WeakMap<vscode.NotebookCell, NotebookCellExecution>();

	private readonly _documentExecutions = new WeakMap<vscode.NotebookDocument, NotebookDocumentExecution>();

	constructor(
		readonly container: ProjectContainer,
		readonly octokit: OctokitProvider
	) {
		this._localDisposables.push(vscode.notebook.onDidChangeCellOutputs(e => {
			e.cells.forEach(cell => {
				if (cell.outputs.length === 0) {
					cell.metadata.statusMessage = undefined;
					cell.metadata.lastRunDuration = undefined;
					cell.metadata.runState = vscode.NotebookCellRunState.Idle;
				}
			});
		}));

		// this.kernel = this;

		vscode.notebook.registerNotebookKernelProvider({
			viewType: 'github-issues',
		}, {
			provideKernels: () => {
				return [this];
			}
		});
	}
	async resolveNotebook(_document: vscode.NotebookDocument, _webview: { readonly onDidReceiveMessage: vscode.Event<any>; postMessage(message: any): Thenable<boolean>; asWebviewUri(localResource: vscode.Uri): vscode.Uri; }): Promise<void> {
		// nothing
	}

	preloads: vscode.Uri[] = [];

	dispose() {
		this._localDisposables.forEach(d => d.dispose());
	}

	// -- utils

	setCellLockState(cell: vscode.NotebookCell, locked: boolean) {
		const redo = () => { cell.metadata = { ...cell.metadata, editable: !locked }; };
		const undo = () => { cell.metadata = { ...cell.metadata, editable: locked }; };
		redo();
		this._onDidChangeNotebook.fire({ document: cell.notebook, undo, redo });
	}

	setDocumentLockState(notebook: vscode.NotebookDocument, locked: boolean) {
		const redo = () => { notebook.metadata = { ...notebook.metadata, editable: !locked, cellEditable: !locked }; };
		const undo = () => { notebook.metadata = { ...notebook.metadata, editable: !locked, cellEditable: !locked }; };
		redo();
		this._onDidChangeNotebook.fire({ document: notebook, undo, redo });
	}

	// -- IO

	async openNotebook(uri: vscode.Uri, context: vscode.NotebookDocumentOpenContext): Promise<vscode.NotebookData> {
		let actualUri = context.backupId ? vscode.Uri.parse(context.backupId) : uri;
		let contents = '';
		try {
			contents = Buffer.from(await vscode.workspace.fs.readFile(actualUri)).toString('utf8');
		} catch {
		}

		let raw: RawNotebookCell[];
		try {
			raw = <RawNotebookCell[]>JSON.parse(contents);
		} catch {
			//?
			raw = [];
		}

		const notebookData: vscode.NotebookData = {
			languages: ['github-issues'],
			metadata: { cellRunnable: false, cellHasExecutionOrder: false },
			cells: raw.map(item => ({
				source: item.value,
				language: item.language,
				cellKind: item.kind,
				outputs: [],
				metadata: { editable: item.editable ?? true, runnable: true }
			}))
		};

		return notebookData;
	}

	saveNotebook(document: vscode.NotebookDocument, _cancellation: vscode.CancellationToken): Promise<void> {
		return this._save(document, document.uri);
	}

	saveNotebookAs(targetResource: vscode.Uri, document: vscode.NotebookDocument, _cancellation: vscode.CancellationToken): Promise<void> {
		return this._save(document, targetResource);
	}

	async backupNotebook(document: vscode.NotebookDocument, context: vscode.NotebookDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.NotebookDocumentBackup> {
		await this._save(document, context.destination);
		return {
			id: context.destination.toString(),
			delete: () => vscode.workspace.fs.delete(context.destination)
		};
	}

	async _save(document: vscode.NotebookDocument, targetResource: vscode.Uri): Promise<void> {
		let contents: RawNotebookCell[] = [];
		for (let cell of document.cells) {
			contents.push({
				kind: cell.cellKind,
				language: cell.language,
				value: cell.document.getText(),
				editable: cell.metadata.editable
			});
		}
		await vscode.workspace.fs.writeFile(targetResource, Buffer.from(JSON.stringify(contents, undefined, 2)));
	}

	// --- kernel world

	async executeAllCells(document: vscode.NotebookDocument): Promise<void> {
		this.cancelAllCellsExecution(document);

		const execution = new NotebookDocumentExecution(document);
		this._documentExecutions.set(document, execution);

		try {
			let currentCell: vscode.NotebookCell;

			execution.cts.token.onCancellationRequested(() => this.cancelCellExecution(document, currentCell));

			for (let cell of document.cells) {
				if (cell.cellKind === vscode.CellKind.Code && cell.metadata.runnable) {
					currentCell = cell;
					await this.executeCell(document, cell);

					if (execution.cts.token.isCancellationRequested) {
						break;
					}
				}
			}
		} finally {
			execution.resolve();
			execution.dispose();
		}
	}

	async executeCell(document: vscode.NotebookDocument, cell: vscode.NotebookCell): Promise<void> {
		this.cancelCellExecution(document, cell);

		const execution = new NotebookCellExecution(cell);
		this._cellExecutions.set(cell, execution);

		const d1 = vscode.notebook.onDidChangeNotebookCells(e => {
			if (e.document !== document) {
				return;
			}
			const didChange = e.changes.some(change => change.items.includes(cell) || change.deletedItems.includes(cell));
			if (didChange) {
				execution.cancel();
			}
		});

		const d2 = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document === cell.document) {
				execution.cancel();
			}
		});

		try {
			return await this._doExecuteCell(execution);
		} finally {
			d1.dispose();
			d2.dispose();
			execution.dispose();
		}
	}

	private async _doExecuteCell(execution: NotebookCellExecution): Promise<void> {

		const doc = await vscode.workspace.openTextDocument(execution.cell.uri);
		const project = this.container.lookupProject(doc.uri);
		const allQueryData = project.queryData(doc);

		// update all symbols defined in the cell so that
		// more recent values win
		const query = project.getOrCreate(doc);
		project.symbols.update(query);

		let allItems: SearchIssuesAndPullRequestsResponseItemsItem[] = [];
		let tooLarge = false;
		// fetch
		try {
			const abortCtl = new AbortController();
			execution.cts.token.onCancellationRequested(_ => abortCtl.abort());

			for (let queryData of allQueryData) {
				const octokit = await this.octokit.lib();

				let page = 1;
				let count = 0;
				while (!execution.cts.token.isCancellationRequested) {

					const response = await octokit.search.issuesAndPullRequests({
						q: queryData.q,
						sort: (<any>queryData.sort),
						order: queryData.order,
						per_page: 100,
						page,
						request: { signal: abortCtl.signal }
					});
					count += response.data.items.length;
					allItems = allItems.concat(<any>response.data.items);
					tooLarge = tooLarge || response.data.total_count > 1000;
					if (count >= Math.min(1000, response.data.total_count)) {
						break;
					}
					page += 1;
				}
			}
		} catch (err) {
			// print as error
			execution.reject(err);
			return;
		}

		// sort
		const [first] = allQueryData;
		const comparator = allQueryData.length >= 2 && allQueryData.every(item => item.sort === first.sort) && cmp.byName.get(first.sort!);
		if (comparator) {
			allItems.sort(first.sort === 'asc' ? cmp.invert(comparator) : comparator);
		}

		let hasManyRepos = false;
		let lastRepo: string | undefined;
		for (let item of allItems) {
			if (!lastRepo) {
				lastRepo = item.repository_url;
			} else if (lastRepo !== item.repository_url) {
				hasManyRepos = true;
				break;
			}
		}

		// "render"
		const maxCount = 13;
		const seen = new Set<string>();
		let html = getHtmlStub();
		let md = '';
		let count = 0;
		for (let item of allItems) {
			if (seen.has(item.url)) {
				continue;
			}
			seen.add(item.url);

			// markdown
			md += `- [#${item.number}](${item.html_url} "${escapeHtml(item.title)}") ${item.title} [${item.labels.map(label => `${label.name}`).join(', ')}]`;
			if (item.assignee) {
				md += `- [@${item.assignee.login}](${item.assignee.html_url} "Issue ${item.number} is assigned to ${escapeHtml(item.assignee.login)}")\n`;
			}
			md += '\n';

			// html
			html += renderItemAsHtml(item, hasManyRepos, count++ >= maxCount);
		}

		//collapse/expand btns
		if (count > maxCount) {
			html += `<div class="collapse"><script>function toggle(element, more) { element.parentNode.parentNode.classList.toggle("collapsed", !more)}</script><span class="more" onclick="toggle(this, true)">▼ Show ${count - (maxCount)} More</span><span class="less" onclick="toggle(this, false)">▲ Show Less</span></div>`;
		}

		// status line
		execution.resolve([{
			outputKind: vscode.CellOutputKind.Rich,
			data: {
				['text/html']: `<div class="${count > maxCount ? 'large collapsed' : ''}">${html}</div>`,
				['text/markdown']: md,
				['x-application/github-issues']: allItems
			}
		}], `${count}${tooLarge ? '+' : ''} results`);
	}

	async cancelCellExecution(_document: vscode.NotebookDocument, cell: vscode.NotebookCell): Promise<void> {
		const execution = this._cellExecutions.get(cell);
		if (execution) {
			execution.cancel();
		}
	}

	async cancelAllCellsExecution(document: vscode.NotebookDocument): Promise<void> {
		const execution = this._documentExecutions.get(document);
		if (execution) {
			execution.cancel();
		}
	}
}

namespace cmp {

	export type ItemComparator = (a: SearchIssuesAndPullRequestsResponseItemsItem, b: SearchIssuesAndPullRequestsResponseItemsItem) => number;

	export const byName = new Map([
		['comments', compareByComments],
		['created', compareByCreated],
		['updated', compareByUpdated],
	]);

	export function invert<T>(compare: (a: T, b: T) => number) {
		return (a: T, b: T) => compare(a, b) * -1;
	}

	export function compareByComments(a: SearchIssuesAndPullRequestsResponseItemsItem, b: SearchIssuesAndPullRequestsResponseItemsItem): number {
		return a.comments - b.comments;
	}

	export function compareByCreated(a: SearchIssuesAndPullRequestsResponseItemsItem, b: SearchIssuesAndPullRequestsResponseItemsItem): number {
		return Date.parse(a.created_at) - Date.parse(b.created_at);
	}

	export function compareByUpdated(a: SearchIssuesAndPullRequestsResponseItemsItem, b: SearchIssuesAndPullRequestsResponseItemsItem): number {
		return Date.parse(a.updated_at) - Date.parse(b.updated_at);
	}
}

export function getHtmlStub(): string {
	return `
<style>
	.item-row {
		display: flex;
		padding: .5em 0;
		color: var(--vscode-foreground);
	}
	.item-row:hover {
		background-color: var(--vscode-list-hoverBackground);
	}
	.collapsed > .item-row.hide {
		display: none;
	}
	.title {
		color: var(--vscode-foreground) !important;
		font-size: 1em;
		text-decoration: none;
	}
	.title:hover {
		text-decoration: underline;
	}
	.title.repo {
		opacity: 70%;
		padding-right: 8px;
	}
	.label {
		font-size: .8em;
		margin: 0 2px;
		padding: 2px
	}
	.label a {
		padding: 2px;
	}
	.status {
		font-size: .8em;
		opacity: 60%;
		padding-top: .5em;
	}
	.assignee {
		flex: shrink;
	}
	.user {
		display: flex;
	}
	.user img {
		padding: 0.1em;
	}
	.item-state {
		flex: shrink;
		padding: 0 .3em;
		opacity: 60%;
	}
	.item-state .octicon {
		fill: var(--vscode-icon-foreground);
	}
	.stats {
		text-align: center;
		font-size: .7em;
		opacity: 60%;
		padding-top: .6em;
	}
	.collapse {
		text-align: center;
		font-size: .9em;
		opacity: 60%;
		display: none;
		cursor: pointer;
		padding: 0.3em 0;
	}
	.large > .collapse {
		display: inherit;
	}
	.collapse > span {
		color: var(--vscode-button-foreground);
		background: var(--vscode-button-background);
		padding: 3px;
	}
	.large.collapsed > .collapse > .less {
		display: none;
	}
	.large:not(.collapsed) > .collapse > .more {
		display: none;
	}
	.item-row .start-working {
		display:none;
	}
	.item-row .start-working a {
		color: var(--vscode-foreground) !important;
		font-size: 0.9em;
		text-decoration: none;
	}
	.item-row .start-working a:hover {
		text-decoration: underline;
	}
	.item-row:hover .start-working {
		display:inline;
	}
</style>`;
}

export function renderItemAsHtml(item: SearchIssuesAndPullRequestsResponseItemsItem, showRepo: boolean, hide: boolean): string {


	const issueOpen = `<svg class="octicon octicon-issue-opened open" viewBox="0 0 14 16" version="1.1" width="16" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M7 2.3c3.14 0 5.7 2.56 5.7 5.7s-2.56 5.7-5.7 5.7A5.71 5.71 0 011.3 8c0-3.14 2.56-5.7 5.7-5.7zM7 1C3.14 1 0 4.14 0 8s3.14 7 7 7 7-3.14 7-7-3.14-7-7-7zm1 3H6v5h2V4zm0 6H6v2h2v-2z"></path></svg>`;
	const issueClosed = `<svg class="octicon octicon-issue-closed closed" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M7 10h2v2H7v-2zm2-6H7v5h2V4zm1.5 1.5l-1 1L12 9l4-4.5-1-1L12 7l-1.5-1.5zM8 13.7A5.71 5.71 0 012.3 8c0-3.14 2.56-5.7 5.7-5.7 1.83 0 3.45.88 4.5 2.2l.92-.92A6.947 6.947 0 008 1C4.14 1 1 4.14 1 8s3.14 7 7 7 7-3.14 7-7l-1.52 1.52c-.66 2.41-2.86 4.19-5.48 4.19v-.01z"></path></svg>`;
	const pr = `<svg class="octicon octicon-git-merge merged" viewBox="0 0 12 16" version="1.1" width="16" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M10 7c-.73 0-1.38.41-1.73 1.02V8C7.22 7.98 6 7.64 5.14 6.98c-.75-.58-1.5-1.61-1.89-2.44A1.993 1.993 0 002 .99C.89.99 0 1.89 0 3a2 2 0 001 1.72v6.56c-.59.35-1 .99-1 1.72 0 1.11.89 2 2 2a1.993 1.993 0 001-3.72V7.67c.67.7 1.44 1.27 2.3 1.69.86.42 2.03.63 2.97.64v-.02c.36.61 1 1.02 1.73 1.02 1.11 0 2-.89 2-2 0-1.11-.89-2-2-2zm-6.8 6c0 .66-.55 1.2-1.2 1.2-.65 0-1.2-.55-1.2-1.2 0-.65.55-1.2 1.2-1.2.65 0 1.2.55 1.2 1.2zM2 4.2C1.34 4.2.8 3.65.8 3c0-.65.55-1.2 1.2-1.2.65 0 1.2.55 1.2 1.2 0 .65-.55 1.2-1.2 1.2zm8 6c-.66 0-1.2-.55-1.2-1.2 0-.65.55-1.2 1.2-1.2.65 0 1.2.55 1.2 1.2 0 .65-.55 1.2-1.2 1.2z"></path></svg>`;

	function getContrastColor(color: string): string {
		// Color algorithm from https://stackoverflow.com/questions/1855884/determine-font-color-based-on-background-color
		const r = Number.parseInt(color.substr(0, 2), 16);
		const g = Number.parseInt(color.substr(2, 2), 16);
		const b = Number.parseInt(color.substr(4, 2), 16);
		return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.5 ? 'black' : 'white';
	}

	// //#region GH PR Integration
	// //todo@jrieken - have API that allows the PR extension to contribute this
	let startWorking: string = '';
	// if (!item.closed_at
	// 	&& vscode.extensions.getExtension('github.vscode-pull-request-github-insiders')
	// ) {
	// 	let repoPos = item.repository_url.lastIndexOf('/');
	// 	let ownerPos = item.repository_url.lastIndexOf('/', repoPos - 1);
	// 	startWorking = `
	// 	<span class="start-working">
	// 	<span>&nbsp;\u2022&nbsp;</span>
	// 	<a href="${vscode.Uri.parse('command:issue.startWorking').with({
	// 		query: JSON.stringify([{
	// 			owner: item.repository_url.substring(repoPos, ownerPos),
	// 			repo: item.repository_url.substring(ownerPos),
	// 			number: item.number
	// 		}])
	// 	}).toString()}">Start Working...</a>
	// 	</span>`;
	// }
	// //#endregion

	function getRepoLabel(): string {
		if (!showRepo) {
			return '';
		}
		let match = /.+\/(.+\/.+)$/.exec(item.repository_url);
		if (!match) {
			return '';
		}
		return `<a href="https://github.com/${match[1]}" class="repo title">${match[1]}</a>`;
	}

	return `
<div class="item-row ${hide ? 'hide' : ''}">
	<div class="item-state">${item.pull_request ? pr : item.closed_at ? issueClosed : issueOpen}</div>
	<div style="flex: auto;">
	${getRepoLabel()}<a href="${item.html_url}" class="title">${escapeHtml(item.title)}</a>
	${item.labels.map(label => `<span class="label" style="background-color: #${label.color};"><a style="color: ${getContrastColor(label.color)};">${label.name}</a></span>`).join('')}
	${startWorking}
	<div class="status">
		<span>#${item.number} opened ${new Date(item.created_at).toLocaleDateString()} by ${escapeHtml(item.user.login)}</span>
	</div>
	</div>
	<div class="user">${!item.assignees ? '' : item.assignees.map(user => `<a href="${user.html_url}"><img src="${user.avatar_url}" width="20" height="20" alt="@${user.login}"></a>`).join('')}</div>
</div>
`;
}

//#region COPY of type definitions that are well hidden inside @octokit/types
declare type SearchIssuesAndPullRequestsResponseItemsItemUser = {
	avatar_url: string;
	events_url: string;
	followers_url: string;
	following_url: string;
	gists_url: string;
	gravatar_id: string;
	html_url: string;
	id: number;
	login: string;
	node_id: string;
	organizations_url: string;
	received_events_url: string;
	repos_url: string;
	starred_url: string;
	subscriptions_url: string;
	type: string;
	url: string;
};
declare type SearchIssuesAndPullRequestsResponseItemsItemPullRequest = {
	diff_url: null;
	html_url: null;
	patch_url: null;
};
declare type SearchIssuesAndPullRequestsResponseItemsItemLabelsItem = {
	color: string;
	id: number;
	name: string;
	node_id: string;
	url: string;
};
declare type SearchIssuesAndPullRequestsResponseItemsItem = {
	assignee: null | SearchIssuesAndPullRequestsResponseItemsItemUser;
	assignees: null | Array<SearchIssuesAndPullRequestsResponseItemsItemUser>;
	body: string;
	closed_at: null;
	comments: number;
	comments_url: string;
	created_at: string;
	events_url: string;
	html_url: string;
	id: number;
	labels: Array<SearchIssuesAndPullRequestsResponseItemsItemLabelsItem>;
	labels_url: string;
	milestone: null;
	node_id: string;
	number: number;
	pull_request: SearchIssuesAndPullRequestsResponseItemsItemPullRequest;
	repository_url: string;
	score: number;
	state: string;
	title: string;
	updated_at: string;
	url: string;
	user: SearchIssuesAndPullRequestsResponseItemsItemUser;
};
//#endregion
