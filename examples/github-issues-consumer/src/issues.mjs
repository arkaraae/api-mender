// Files a bug report in a GitHub repository and assigns it to the on-call engineer.
export async function fileBug({ owner, repo, title, details, onCall, token }) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title, body: details, assignee: onCall, labels: ['bug'] }),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const issue = await response.json();
  return { number: issue.number, assignedTo: issue.assignees.map(user => user.login) };
}
