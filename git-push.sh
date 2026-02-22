source ./.env;

#ssh-add -D

ssh-add "${GITLAB_KEY_PATH}" && ssh-add "${GITHUB_KEY_PATH}"

#git push github --all && git push gitlab --all
git push github && git push gitlab
