<script lang="ts">
	let { post }: { post: { id: string; editedAt?: string | null; removed?: boolean } } = $props()
</script>

{#if post.editedAt}
	{#if post.removed}
		<!-- /post/:id/history 404s for a removed post (its revisions are an
		     admin-only record) — degrade to the same label, same styling, just
		     not a link, rather than offer a dead one. -->
		<span class="edited" title={post.editedAt}>edited</span>
	{:else}
		<a class="edited" href="/post/{post.id}/history" title={post.editedAt}>edited</a>
	{/if}
{/if}
