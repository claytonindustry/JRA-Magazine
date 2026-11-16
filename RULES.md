# Who may read and write what

`database.rules.json` is the file to paste into **Realtime Database → Rules** in
the Firebase console. It must contain a `rules` object and nothing else — the
console refuses a file with anything beside it at the top level, comments
included, which is why the explanation lives here.

## The list is the whole of it

The published magazine is public to read. Nothing else is, and nothing at all
can be written, without a line under `/people` for the signed-in address.

That is what makes removing somebody the whole of taking their access away.
The editor, the published issues and the photograph upload all ask the same
question of the same list, so one deletion closes every door at once — even
while their login still exists and their token still has an hour to run. The
rules check the list on every request, not once at sign-in.

A person is filed under their address, with dots written as commas, because a
database key may not hold a dot: `people/colin@jramag,org`. The rules derive
the same key from whoever is signed in, using `replace()`, which the
[rules reference](https://firebase.google.com/docs/reference/security/database)
defines as replacing *every* instance. The editor and the upload Worker spell
it the same way. You never type that form yourself.

## Two kinds of person

**Editor** — writes. Start an article, edit any article's words, photographs,
layout and translations. Upload photographs. Curate the gallery. Arrange a
magazine's contents, cover and settings. Edit About and Links.

**Owner** — all of that, and alone: create or delete a magazine, delete an
article, publish or unpublish anything, add or remove a language, delete a
photograph from the library, and add, remove or re-rank people.

The database can tell these apart. A create, an edit and a delete are three
different things to the rules:

| | an editor may | an owner may |
|---|---|---|
| `articles/$id` | create, change | create, change, delete |
| `magazines/$id` | change | create, change, delete |
| `images/$id` | create, change | create, change, delete |
| `icons`, `pages` | change | change |
| `issues`, `library`, `searchindex`, `site`, `gallery` | — | change |
| `people/$person` | — | change |

The buttons go too, so an editor never presses something that then fails. But
the buttons are a courtesy and these rules are the boundary: an editor who went
round the page entirely would still be refused.

## Setting it up

In the Firebase console:

1. **Authentication → Sign-in method** — enable Email/Password.
2. **Authentication → Settings → User actions** — leave **Enable create
   (sign-up)** *ticked*. The editor makes logins through the same endpoint this
   switch controls, so turning it off would stop you adding people. See the
   note below about what that means.
3. **Realtime Database → Data** — add the first person by hand, before
   publishing these rules. An empty `/people` lets nobody write anything,
   including whoever would add the first line.
4. **Realtime Database → Rules** — paste `database.rules.json` and publish.

The data viewer drops into read-only mode on a database this size, so the root
has no **+** button. Go straight to the node by address:

```
https://console.firebase.google.com/project/jra-magazine/database/jra-magazine-default-rtdb/data/~2Fpeople
```

`~2F` is how the console writes a `/`. An empty node is small, so it opens
editable. The first record is:

```
people
  └─ you@example,com        ← your address, dots written as commas
       name  : "Your Name"
       role  : "owner"
       added : 0
```

`added` is a number: type `0`, not `"0"`.

## What leaving sign-up on means

Anybody who knows the project's public API key — which is in the page, as it
has to be — can create a login by calling Firebase directly. There is no
sign-up form anywhere in the editor, so this takes deliberate effort, and what
they get is worth nothing:

- The editor shows them one sentence, *"You are not an editor."*, and a way to
  sign out.
- Every write is refused.
- Every unpublished thing — articles, magazines, images, pages — is unreadable.
- The People list is unreadable, so they cannot even see who the editors are.
  The one exception is their own line, which does not exist; it reads as
  nothing, which is the answer they are owed.
- The photograph upload refuses them.

What they can read is the published magazine, which is public to everyone
anyway.

The trade is that stray logins can accumulate in **Authentication → Users**.
They are inert. Delete them there if they bother you.

If you would rather no one could register at all, the editor can no longer make
logins and you go back to creating each one in the console; or the upload
Worker can be given a Google service-account key and do it instead. Both are
changes to make deliberately, not settings to flip.

## Adding somebody afterwards

**Account & settings → People → Add.** A name, an address, Editor or Owner.
That makes their login *and* their line on the list in one press, and emails
them a link to set their own password — nobody here invents one for them.

If the address already has a login, it says so and just adds the line.

Removing somebody takes away everything they can do, at once. It does not
delete their login, which is a console job if they are gone for good.

## Checking it before you trust it

The **Rules Playground** on the Rules tab simulates a request without making
one. Worth a few minutes before relying on this:

- **write** to `articles/anything` as an authenticated user with your own
  address — allowed
- the same write with any other address — denied
- **write** to `issues/99` as an editor's address — denied; as an owner's —
  allowed
- **read** of `library` with no authentication — allowed
- **read** of `articles` with no authentication — denied

The Playground asks for a UID rather than an address, and there is a field
beside it for the token payload; put the address in as `email` so
`auth.token.email` has something to read.
