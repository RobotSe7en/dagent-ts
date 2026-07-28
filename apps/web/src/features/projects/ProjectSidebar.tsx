import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, FolderKanban, MessageSquare, Plus } from 'lucide-react';
import { useState } from 'react';

import { api } from '../../api/client.js';
import { useWorkspace } from '../../state/workspace.js';

export function ProjectSidebar() {
  const queryClient = useQueryClient();
  const { projectId, conversationId, selectProject, selectConversation } = useWorkspace();
  const [creatingProject, setCreatingProject] = useState(false);
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
  });
  const conversations = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => {
      if (projectId === undefined) throw new Error('Missing project.');
      return api.listConversations(projectId);
    },
    enabled: projectId !== undefined,
  });
  const createProject = useMutation({
    mutationFn: api.createProject,
    onSuccess: async (project) => {
      selectProject(project.id);
      setCreatingProject(false);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const createConversation = useMutation({
    mutationFn: api.createConversation,
    onSuccess: async (conversation) => {
      selectConversation(conversation.id);
      await queryClient.invalidateQueries({
        queryKey: ['conversations', conversation.projectId],
      });
    },
  });

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">D</span>
        <div>
          <strong>Dagent</strong>
          <small>Agent workspace</small>
        </div>
      </div>
      <div className="sidebar-heading">
        <span>Projects</span>
        <button
          className="icon-button"
          title="新建项目"
          onClick={() => {
            setCreatingProject((open) => !open);
          }}
        >
          <Plus size={15} />
        </button>
      </div>
      {creatingProject ? (
        <ProjectForm
          busy={createProject.isPending}
          onSubmit={(name, rootPath) => {
            createProject.mutate({ name, rootPath });
          }}
        />
      ) : null}
      <nav className="project-list" aria-label="项目">
        {projects.data?.map((project) => (
          <div key={project.id}>
            <button
              className={`project-row ${project.id === projectId ? 'selected' : ''}`}
              onClick={() => {
                selectProject(project.id);
              }}
            >
              <ChevronRight size={14} className={project.id === projectId ? 'rotated' : ''} />
              <FolderKanban size={16} />
              <span>{project.name}</span>
            </button>
            {project.id === projectId ? (
              <div className="conversation-list">
                {conversations.data?.map((conversation) => (
                  <button
                    key={conversation.id}
                    className={`conversation-row ${
                      conversation.id === conversationId ? 'selected' : ''
                    }`}
                    onClick={() => {
                      selectConversation(conversation.id);
                    }}
                  >
                    <MessageSquare size={14} />
                    <span>{conversation.title}</span>
                  </button>
                ))}
                <button
                  className="new-conversation"
                  onClick={() => {
                    createConversation.mutate({
                      projectId: project.id,
                      title: `Conversation ${(conversations.data?.length ?? 0) + 1}`,
                    });
                  }}
                >
                  <Plus size={13} />
                  新对话
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <span className="status-dot" />
        Local runtime
      </div>
    </aside>
  );
}

function ProjectForm(props: {
  readonly busy: boolean;
  readonly onSubmit: (name: string, path: string) => void;
}) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  return (
    <form
      className="project-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit(name, path);
      }}
    >
      <input
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
        placeholder="项目名称"
        required
      />
      <input
        value={path}
        onChange={(event) => {
          setPath(event.target.value);
        }}
        placeholder="/path/to/workspace"
        required
      />
      <button disabled={props.busy}>创建</button>
    </form>
  );
}
