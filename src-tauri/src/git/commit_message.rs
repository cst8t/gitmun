use super::types::CommitTrailer;

pub(super) struct ProcessedCommitBody {
    pub body: String,
    pub trailers: Vec<CommitTrailer>,
}

pub(super) fn process_commit_body(body: &str) -> ProcessedCommitBody {
    let lines: Vec<&str> = body.lines().collect();
    let start = lines
        .iter()
        .position(|line| !line.trim().is_empty())
        .unwrap_or(lines.len());
    let end = lines
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .map(|index| index + 1)
        .unwrap_or(start);

    let mut trailer_start = end;
    let mut trailers = Vec::new();
    while trailer_start > start {
        let Some(trailer) = parse_trailer(lines[trailer_start - 1]) else {
            break;
        };
        trailers.push(trailer);
        trailer_start -= 1;
    }
    trailers.reverse();

    let prose_end = lines[start..trailer_start]
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .map(|index| start + index + 1)
        .unwrap_or(start);

    ProcessedCommitBody {
        body: lines[start..prose_end].join("\n"),
        trailers,
    }
}

fn parse_trailer(line: &str) -> Option<CommitTrailer> {
    let trimmed = line.trim();
    let colon_position = trimmed.find(':')?;
    let key = &trimmed[..colon_position];
    let value = trimmed[colon_position + 1..].trim();
    let key_valid = !key.is_empty()
        && key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-');

    if !key_valid || value.is_empty() {
        return None;
    }

    Some(CommitTrailer {
        key: key.to_string(),
        value: value.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_plain_prose() {
        let result = process_commit_body("Explain the change.");

        assert_eq!(result.body, "Explain the change.");
        assert!(result.trailers.is_empty());
    }

    #[test]
    fn preserves_multiple_paragraphs() {
        let result = process_commit_body("First paragraph.\n\nSecond paragraph.");

        assert_eq!(result.body, "First paragraph.\n\nSecond paragraph.");
        assert!(result.trailers.is_empty());
    }

    #[test]
    fn extracts_trailer_only_body() {
        let result = process_commit_body("Reviewed-by: Alice");

        assert!(result.body.is_empty());
        assert_eq!(result.trailers.len(), 1);
        assert_eq!(result.trailers[0].key, "Reviewed-by");
        assert_eq!(result.trailers[0].value, "Alice");
    }

    #[test]
    fn separates_prose_from_multiple_trailers() {
        let result =
            process_commit_body("Explain the change.\n\nReviewed-by: Alice\nSigned-off-by: Bob");

        assert_eq!(result.body, "Explain the change.");
        assert_eq!(result.trailers.len(), 2);
        assert_eq!(result.trailers[0].key, "Reviewed-by");
        assert_eq!(result.trailers[1].key, "Signed-off-by");
    }

    #[test]
    fn leaves_colon_containing_prose_in_body() {
        let result = process_commit_body("Context follows.\n\nNot A Trailer: prose value");

        assert_eq!(
            result.body,
            "Context follows.\n\nNot A Trailer: prose value"
        );
        assert!(result.trailers.is_empty());
    }

    #[test]
    fn trims_blank_boundaries_and_preserves_internal_whitespace() {
        let result = process_commit_body(
            "\n\n  First line  \n\n    Indented line\n\nReviewed-by: Alice\n\n",
        );

        assert_eq!(result.body, "  First line  \n\n    Indented line");
        assert_eq!(result.trailers.len(), 1);
    }

    #[test]
    fn requires_trailers_to_be_contiguous_at_end() {
        let result = process_commit_body("Reviewed-by: Alice\n\nExplanation after metadata.");

        assert_eq!(
            result.body,
            "Reviewed-by: Alice\n\nExplanation after metadata."
        );
        assert!(result.trailers.is_empty());
    }
}
