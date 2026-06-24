# AWS Tool

AWS identity, S3, EC2, CloudWatch logs, Secrets Manager, profiles, and more.

## Commands

| Command | Description |
|---------|-------------|
| `whoami` | Show current AWS identity via STS |
| `s3` | List S3 buckets; `s3 <bucket>` to explore objects |
| `ec2` | List EC2 instances; `ec2 <id>` for instance details |
| `logs` | List CloudWatch log groups; `logs <group>` for streams |
| `secrets` | List secrets, view values, update interactively |
| `secret update <name>` | Add/edit/delete keys in a JSON secret |
| `profile` | List all profiles; `profile <name>` to switch; `profile add` to create |
| `login` | SSO login (if SSO configured) or Console sign-in |
| `help` | Get SSO URL help, IAM key setup, or open AWS Console |
| `regions` | Pick a region to set as default for current profile |

## Secrets workflow

```
devkit[aws]> secrets                    # Lists all secrets with type-to-search
devkit[aws]> secrets myapp/db           # View a specific secret
```

After viewing a secret:
- Type `y` to view another secret
- Type `e` to enter the interactive editor — add, edit, or delete JSON keys
- Press Enter to exit

## Profile persistence

Active profile and region are saved to `~/.devkit/aws/state.json` and survive restarts. Environment variables `AWS_PROFILE` and `AWS_REGION` take precedence.

## Configuration

Profiles stored in standard AWS locations:
- `~/.aws/config` — profile sections with region
- `~/.aws/credentials` — access key ID and secret access key
