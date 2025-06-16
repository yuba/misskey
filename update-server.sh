#!/bin/bash
set -euC

if [[ $(git status --porcelain) != "" ]]; then
	echo "There are uncommitted changes in the repository. Please commit or stash them before updating."
	exit 1
fi

git checkout master
git fetch ssh://git@github.com/misskey-dev/misskey.git
tag=$(git tag | grep "^20" | grep -v "-" | sort | tail -n1)
git merge $tag

docker build -t yuba/misskey:latest -t yuba/misskey:$tag-reax.work-1 .

docker push yuba/misskey:latest
docker push yuba/misskey:$tag-reax.work-1

ssh ballatore reax-work/bin/update-misskey.sh yuba/misskey:$tag-reax.work-1
