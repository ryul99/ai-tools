# OKF Wiki Autosave

This optional Claude Code companion keeps shared OKF concepts current after
main-agent turns. It does not create per-session documents.

Install the base plugin without hooks:

```sh
claude plugin install okf-wiki@ryul99-ai-tools
```

Install autosave and its base-plugin dependency:

```sh
claude plugin install okf-wiki-autosave@ryul99-ai-tools
```

The hook requires `okf` and `claude` on `PATH`, an active Claude subscription
login, and either an OKF bundle in the current directory hierarchy or an
`OKF_ROOT` value. It only considers concepts tagged `worklog-managed`.

The child `claude -p` process runs in safe mode without tools, plugins, hooks,
skills, or session persistence. API-key, gateway, and cloud-provider routing
environment variables are removed from that child so the active subscription
OAuth credential is used.
