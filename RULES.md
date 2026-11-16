# Who may read and write what

`database.rules.json` is the file to paste into **Realtime Database → Rules**
in the Firebase console. It must contain a `rules` object and nothing else —
the console refuses a file with anything beside it at the top level, comments
included, which is why the explanation lives here instead.

## What it says

The published magazine is public to read and nothing else is. Writing anything
at all — an article, an issue, the gallery, the site settings — needs a line
under `/people` for the signed-in person.

That is what makes removing somebody from that list the whole of taking their
access away. The editor, the published issues and the photograph upload all ask
the same question of the same list, so one deletion closes every door, at once,
even while their login still exists and their token is still valid. A shared
password could never do that.

## Why people are filed under a user id

A person is stored under the user id Firebase gives them — what `auth.uid`
holds — rather than under their address. An address reads better, but a
database key may not contain a dot, so the rules would have to rewrite
`a.b@c.org` into some dotless form to find anybody, and a lock that depends on
a string operation behaving exactly as assumed is a lock nobody has tried.
`auth.uid` is handed to the rules as it is. The address is kept inside the
record, where only people read it.

## Setting it up

In the Firebase console:

1. **Authentication → Sign-in method** — enable Email/Password.
2. **Authentication → Settings → User actions** — uncheck **Enable create
   (sign-up)**. Without this, somebody could register an address of their own
   choosing and have a login on the project.
3. **Realtime Database → Data** — add the first person by hand, before
   publishing these rules. An empty `/people` lets nobody write anything,
   including whoever would add the first line.
4. **Realtime Database → Rules** — paste `database.rules.json` and publish.

The data viewer drops into read-only mode on a database this size, so the root
has no **+** button. Go straight to the node instead, by address:

```
https://console.firebase.google.com/project/jra-magazine/database/jra-magazine-default-rtdb/data/~2Fpeople
```

`~2F` is how the console writes a `/`. An empty node is small, so it opens
editable. The first record is:

```
people
  └─ <your User UID, from Authentication → Users>
       name  : "Your Name"
       email : "you@example.com"
       role  : "owner"
       added : 0
```

`added` is a number: type `0`, not `"0"`.

## Adding somebody afterwards

Two things make an editor, and both are needed:

1. A login — **Authentication → Users → Add user**.
2. A line on the list — **Account & settings → People** in the editor.

Neither creates the other. Removing the line takes away everything they can do;
it does not delete their login, which is done in the console if they are gone
for good.

A person who signs in before an owner has listed them is told so, and shown the
id to pass on.

## Checking it before you trust it

The **Rules Playground** on the Rules tab simulates a request without making
one. Worth two minutes before relying on this:

- a **write** to `articles` as an authenticated user with your own UID — allowed
- the same write with any other UID — denied
- a **read** of `library` with no authentication — allowed
- a **read** of `articles` with no authentication — denied
