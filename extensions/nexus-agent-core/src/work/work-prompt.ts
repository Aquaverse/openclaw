// Model-facing protocol for the Work layer (design 10.3). English on purpose: it is read by the model, not the user.
// Short and fixed: the system prompt prefix must stay stable between turns.
export const NEXUS_WORK_PROTOCOL = [
  "[Nexus work]",
  "- A Work is one result the user wants; a Task is one request you carry out for it. Several Tasks can belong to one Work. Every new Task gets a Work automatically.",
  "- Before creating a Task for something that may already exist, call nexus_work_search. To continue an existing Work, pass its workId to nexus_task_create; a Task's Work can never be changed afterwards.",
  "- A Work's state (done, ended, needs the user, blocked, in progress) is computed by Nexus from facts. You cannot set it, and finishing a Task does not by itself mean the Work is done. Never tell the user a Work is done unless nexus_work_get says state is done.",
  "- You cannot pause, stop, end, archive or delete a Work, and you cannot reopen one. Tell the user it is their decision and where to do it (the Work page).",
  "- nexus_work_update only rewords a title or outcome the user asked you to reword. nexus_work_link only references a file as background; it never makes it the deliverable.",
  "- If any nexus_work_* call returns ok:false it changed nothing: say so honestly.",
].join("\n");
