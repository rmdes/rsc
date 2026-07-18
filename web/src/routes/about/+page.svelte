<!-- Static "reason to exist" page: why / what / how / who. Prose only — no
     load, no data, works with JS off. Reuses the .lens single-column idiom
     (see /u/[handle]) and MASTER.md tokens; the scoped styles below only set
     reading rhythm. Every claim traces to README.md + the founding design at
     docs/superpowers/specs/2026-07-15-textcaster-design.md — keep roadmap
     items marked as roadmap. -->
<script lang="ts">
	import ThemeToggle from '$lib/ThemeToggle.svelte'
</script>

<svelte:head>
	<title>About — Textcaster</title>
	<meta
		name="description"
		content="Textcaster is a feeds-native social timeline: people who post through the instance and people who post from their own site are equal citizens in one live timeline, and whole conversations travel as plain RSS."
	/>
</svelte:head>

<div class="lens about">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

	<h1>A social timeline built natively on feeds.</h1>

	<p class="lede">
		Two worlds kept their distance for years: Dave Winer's RSS and Textcasting
		lineage, and the IndieWeb. Textcaster unifies them — and refuses the purity
		lines between them. People who post <em>through</em> the instance and people
		who post from <em>their own website's feed</em> are equal citizens of the
		same live timeline, and following, replies, and whole conversations travel
		as plain RSS instead of a proprietary API.
	</p>

	<p class="status">Pre-release, but deep — real end to end today, no release cut yet.</p>

	<section>
		<h2>Why it exists</h2>
		<p>
			Social platforms lock your posts, your graph, and your conversations
			inside an API only they control. Open feeds have carried writing across
			the web for two decades — but they were treated as a read-only broadcast
			channel, never as the place a conversation actually lives.
		</p>
		<p>
			Textcaster's bet is that a conversation can travel over nothing but RSS.
			A reply is a post; a thread is reconstructed from feeds; a conversation
			can federate from one instance to another and back again with no extra
			protocol. If it works over feeds, no single service owns it — and anyone
			who already publishes a feed is already halfway in.
		</p>
	</section>

	<section>
		<h2>What it is</h2>
		<ul class="features">
			<li>
				<strong>One live timeline.</strong> Local posts and polled-in remote
				feed items share a single server-rendered timeline that updates live.
				It works with JavaScript off — the live updates are an enhancement, not
				a requirement.
			</li>
			<li>
				<strong>Rich posting.</strong> A Markdown composer with live preview,
				tables, emoji shortcodes, and syntax-highlighted code. What you preview
				is what readers get, and every post is sanitized before it reaches a
				browser.
			</li>
			<li>
				<strong>Real conversations over plain RSS.</strong> Replies thread
				inline and on a dedicated conversation page, reconstructed from feeds —
				with honest orphaning when a parent is missing and healing when a reply
				arrives before its parent.
			</li>
			<li>
				<strong>Feeds in.</strong> Subscribe to any RSS, Atom, or JSON Feed,
				import an OPML blogroll, or point at a plain web page and let discovery
				find its feed. Every outbound fetch is guarded against SSRF.
			</li>
			<li>
				<strong>Feeds out, live.</strong> Each user gets an RSS and JSON feed,
				and the instance publishes an all-users firehose. New posts are pushed
				to subscribers in real time over WebSub and rssCloud — so federation is
				live, not just polled.
			</li>
			<li>
				<strong>Interop with rss.chat.</strong> Textcaster round-trips Dave
				Winer's rss.chat: a conversation can federate A→B→A over plain RSS, and
				our feeds are walkable by his own thread walker unchanged.
			</li>
			<li>
				<strong>Accounts.</strong> Browse and post as a guest first, then
				upgrade to a verified email account or sign in with a magic link.
			</li>
			<li>
				<strong>Self-hosting.</strong> A one-command Docker dev stack, and a
				production stack that runs behind Caddy with automatic HTTPS.
			</li>
		</ul>
		<p class="next">
			<strong>Next, not yet built:</strong> IndieAuth sign-in and Micropub
			posting-in, Webmention, and optional ActivityPub reach into the fediverse.
		</p>
	</section>

	<section>
		<h2>How it works</h2>
		<p>
			Under the hood there are two parts: a headless core service that owns the
			feeds, federation, threading, and the timeline, and a web app that is the
			only thing your browser talks to. The core speaks open standards the rest
			of the web already understands — RSS, OPML, JSON Feed, WebSub, and
			rssCloud — so it federates with other sites and instances directly,
			without anyone adopting a Textcaster-specific protocol.
		</p>
		<p>
			The page you're reading, and every post, is rendered and sanitized
			through a single trusted path on the server before it ever reaches a
			browser. Nothing else is a browser-facing surface.
		</p>
	</section>

	<section>
		<h2>Who built it — and on whose shoulders</h2>
		<p>
			Textcaster is built by <a href="https://github.com/rmdes">Ricardo (rmdes)</a>.
			The name is itself an attribution. It stands on ideas and standards it did
			not invent:
		</p>
		<ul class="credits">
			<li>
				<strong><a href="https://textcasting.org">Dave Winer & textcasting.org</a></strong>
				— the Textcasting manifesto, RSS, OPML, rssCloud, and the
				<a href="https://github.com/scripting/rss.chat">rss.chat</a> idea this reimagines.
			</li>
			<li><strong>The IndieWeb community</strong> — Micropub, Webmention, IndieAuth, and microformats2.</li>
			<li><strong>JSON Feed</strong> — Manton Reece and Brent Simmons.</li>
			<li><strong>WebSub</strong> and the broader open-feed ecosystem.</li>
		</ul>
		<p>
			It's open source under the MIT license and made to be self-hosted. The
			<a href="https://github.com/rmdes/textcaster">source</a>, the
			<a href="https://github.com/rmdes/textcaster/blob/main/README.md">README</a>, and the
			<a href="https://github.com/rmdes/textcaster/blob/main/docs/superpowers/specs/2026-07-15-textcaster-design.md">founding design</a>
			are all public.
		</p>
	</section>
</div>

<style>
	/* Reading rhythm only; colors/spacing/fonts come from app.css tokens. */
	.about {
		max-width: 44rem;
		line-height: 1.7;
	}

	.about h1 {
		font-size: 2.25rem;
		margin-block: var(--space-md) 0;
	}

	.lede {
		font-size: 1.15rem;
		color: var(--color-secondary);
		margin-block: 0;
	}

	.status {
		align-self: flex-start;
		margin: 0;
		padding: var(--space-xs) var(--space-md);
		border: 1px solid var(--color-border);
		border-radius: 999px;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-accent);
	}

	.about section {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}

	.about h2 {
		font-size: 1.5rem;
		margin: 0;
	}

	.about p {
		margin: 0;
	}

	.features,
	.credits {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}

	.features strong,
	.credits strong {
		color: var(--color-foreground);
	}

	.next {
		color: var(--color-secondary);
		font-size: 0.9375rem;
	}
</style>
