def latest(tags):
    def version_key(tag):
        return tuple(int(part) for part in tag.split("."))

    return max(tags, key=version_key)
