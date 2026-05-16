# Project-PPT-V2 Assistant SKILL Guide

This document defines the roles and operational skills for the AI Assistant working on this project. 

## 1. Role Definition
Standard operation procedure for capturing project state and performing updates.

## 2. Core Skills & Commands

### SKILL: State Management
When tasks are completed or issues are resolved, the AI must update the corresponding summary files to maintain "Long-term Memory".

| Command | Target File | Source of Truth / Context |
| :--- | :--- | :--- |
| **Update Finish List** | `finish_list.md` | Move completed items from `todo_list.md` to here. |
| **Update Todo List** | `todo_list.md` | Record new requirements, security patches, or refactoring goals. |
| **Log Success** | `success_summary.md` | Record new validated application scenarios or feature breakthroughs. |
| **Log Fault/Fix** | `fault_summary.md` | Document critical bugs found and their "Ultimate Solutions" (e.g., Encoding fixes). |
| **Update Intro** | `project_Intrudcue.md` | Update architecture changes, MQTT topics, or API endpoints. |

## 3. Operational Rules for AI
1.  **Read First**: Before any major implementation, read `todo_list.md` to ensure alignment.
2.  **Incremental Logging**: Do not overwrite the entire file unless necessary; append or update specific sections.
3.  **Cross-Reference**: When a bug is fixed (documented in `fault_summary.md`), check if any `todo_list.md` items can now be closed.
4.  **Format Consistency**: Use Markdown lists and code blocks for technical details.

## 4. Current File Map
- **Finish List**: [finish_list.md](finish_list.md)
- **Todo List**: [todo_list.md](todo_list.md)
- **Success Summary**: [success_summary.md](success_summary.md)
- **Fault Summary**: [fault_summary.md](fault_summary.md)
- **Project Introduce**: [project_Intrudcue.md](project_Intrudcue.md)

## 5. Metadata Update Trigger
Whenever a `git commit` is about to be suggested, the Assistant should verify if the above documents need synchronization.
