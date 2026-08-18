import { requestJson } from "./api";
import type { TrustLevel } from "./feed";

export interface TopicDetailAuthor {
  id: string;
  username: string;
  displayName: string;
  trustLevel: TrustLevel;
}

export interface TopicDetailPost {
  id: string;
  number: number;
  markdown: string;
  likeCount: number;
  liked?: boolean;
  createdAt: string;
  updatedAt: string;
  author: TopicDetailAuthor;
}

export interface TopicDetailResponse {
  topic: {
    id: string;
    slug: string;
    title: string;
    status: "open" | "locked" | "archived" | "deleted" | "pending";
    minViewLevel: TrustLevel;
    effectiveMinViewLevel: TrustLevel;
    replyCount: number;
    likeCount: number;
    bumpedAt: string;
    createdAt: string;
    category: {
      id: string;
      slug: string;
      name: string;
      accent: string;
    };
    author: TopicDetailAuthor;
  };
  posts: TopicDetailPost[];
  tags: Array<{ slug: string; name: string }>;
  access: {
    readOnly: boolean;
    canReply: boolean;
    replyReason: string;
    via: string;
  };
}

export interface CreateReplyResponse {
  post: {
    id: string;
    status: "published" | "pending";
    reviewRequired: boolean;
  };
}

export interface LikeReactionResponse {
  reaction: {
    type: "like";
    active: boolean;
    changed: boolean;
  };
  post: {
    id: string;
    likeCount: number;
  };
  topic: {
    id: string;
    likeCount: number;
  };
}

export async function getTopicDetail(
  topicId: string,
  signal?: AbortSignal,
): Promise<TopicDetailResponse> {
  return requestJson<TopicDetailResponse>(
    `/api/topics/${encodeURIComponent(topicId)}`,
    { method: "GET", signal },
  );
}

export async function createReply(
  topicId: string,
  body: string,
  csrfToken: string,
): Promise<CreateReplyResponse> {
  return requestJson<CreateReplyResponse>(
    `/api/topics/${encodeURIComponent(topicId)}/replies`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ body }),
    },
  );
}

export async function setLikeReaction(
  postId: string,
  desired: boolean,
  csrfToken: string,
): Promise<LikeReactionResponse> {
  return requestJson<LikeReactionResponse>(
    `/api/posts/${encodeURIComponent(postId)}/reactions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ type: "like", desired }),
    },
  );
}
