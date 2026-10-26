# Deploy Checklist

Before deploying to production, verify ALL items:

## Pre-Deploy
- [ ] All changes committed and pushed to GitHub
- [ ] Branch merged to master (or deploy branch identified)
- [ ] All automated tests pass
- [ ] Staging verified — feature works end-to-end
- [ ] Grok QA PASS (if applicable)
- [ ] No console errors on staging
- [ ] Database migrations identified (if any)

## Deploy
- [ ] Josh approved deploy ("push to prod")
- [ ] Changelog/patch notes prepared
- [ ] Deploy via deploy.sh (NEVER direct pm2 restart)
- [ ] Health check passes after deploy

## Post-Deploy
- [ ] Verify feature works on prod
- [ ] Monitor logs for 5 minutes
- [ ] No error spikes
- [ ] Update GitHub Issues (close resolved)
